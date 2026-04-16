import * as fs from "node:fs";
import * as path from "node:path";
import { estimateTokenCount, splitByTokens } from "tokenx";
import type { CorpusChunk } from "./corpus.ts";

export interface LongBenchItem {
  _id: string;
  domain: string;
  sub_domain: string;
  difficulty: "easy" | "hard";
  length: "short" | "medium" | "long";
  question: string;
  choice_A: string;
  choice_B: string;
  choice_C: string;
  choice_D: string;
  answer: "A" | "B" | "C" | "D";
  context: string;
}

export interface LongBenchPayload {
  _id: string;
  domain: string;
  sub_domain: string;
  difficulty: "easy" | "hard";
  length: "short" | "medium" | "long";
  question: string;
  choices: Record<LongBenchAnswer, string>;
  answer: LongBenchAnswer;
  context: string;
}

export interface LongBenchSelectionOptions {
  difficulty?: Array<LongBenchItem["difficulty"]>;
  lengths?: Array<LongBenchItem["length"]>;
  sampleSize?: number;
  maxFullDumpPromptTokens?: number;
  taskTypeTargets?: Partial<Record<LongBenchTaskType, number>>;
}

export interface LongBenchSelectionResult {
  selected: LongBenchItem[];
  eligible: LongBenchItem[];
  filteredOutByFitCap: LongBenchItem[];
}

export type LongBenchAnswer = "A" | "B" | "C" | "D";
export type LongBenchTaskType =
  | "single-hop-qa"
  | "multi-hop-qa"
  | "summarization-interpretive"
  | "icl-translation"
  | "structured-code-reasoning";

export const LONGBENCH_TASK_TYPE_ORDER: LongBenchTaskType[] = [
  "single-hop-qa",
  "multi-hop-qa",
  "summarization-interpretive",
  "icl-translation",
  "structured-code-reasoning",
];

export const DEFAULT_LONGBENCH_DATA_PATH = "packages/evals/corpus/longbench-v2/data.json";
export const DEFAULT_SAMPLE_SIZE = 48;
export const DEFAULT_FULL_DUMP_CONTEXT_WINDOW = 400_000;
export const DEFAULT_OUTPUT_TOKEN_RESERVE = 2_048;
export const DEFAULT_PROMPT_TOKEN_BUFFER = 8_192;
export const DEFAULT_FULL_DUMP_MAX_PROMPT_TOKENS =
  DEFAULT_FULL_DUMP_CONTEXT_WINDOW - DEFAULT_OUTPUT_TOKEN_RESERVE - DEFAULT_PROMPT_TOKEN_BUFFER;
export const DEFAULT_RAG_TOP_K = 20;
export const DEFAULT_RAG_CHUNK_SIZE = 500;
export const DEFAULT_RAG_CHUNK_OVERLAP = 50;

const FULL_DUMP_SYSTEM_PROMPT =
  "Answer the multiple choice question based on the provided context. Reply with just the letter (A, B, C, or D).";

const TASK_TYPE_BY_SUBDOMAIN: Record<string, LongBenchTaskType> = {
  "Code Repository Understanding / Code repo QA": "structured-code-reasoning",
  "Long In-context Learning / Many-shot learning": "icl-translation",
  "Long In-context Learning / New language translation": "icl-translation",
  "Long In-context Learning / User guide QA": "icl-translation",
  "Long Structured Data Understanding / Knowledge graph reasoning": "structured-code-reasoning",
  "Long Structured Data Understanding / Table QA": "structured-code-reasoning",
  "Long-dialogue History Understanding / Agent history QA": "single-hop-qa",
  "Long-dialogue History Understanding / Dialogue history QA": "single-hop-qa",
  "Multi-Document QA / Academic": "multi-hop-qa",
  "Multi-Document QA / Financial": "multi-hop-qa",
  "Multi-Document QA / Governmental": "multi-hop-qa",
  "Multi-Document QA / Legal": "multi-hop-qa",
  "Multi-Document QA / Multi-news": "summarization-interpretive",
  "Single-Document QA / Academic": "summarization-interpretive",
  "Single-Document QA / Detective": "single-hop-qa",
  "Single-Document QA / Event ordering": "multi-hop-qa",
  "Single-Document QA / Financial": "multi-hop-qa",
  "Single-Document QA / Governmental": "summarization-interpretive",
  "Single-Document QA / Legal": "summarization-interpretive",
  "Single-Document QA / Literary": "summarization-interpretive",
};

export function loadLongBenchData(filePath: string): LongBenchItem[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as LongBenchItem[];
}

export function resolveLongBenchDataPath(
  repoRoot: string,
  relativePath = DEFAULT_LONGBENCH_DATA_PATH,
): string {
  return path.resolve(repoRoot, relativePath);
}

export function buildLongBenchPayload(item: LongBenchItem): LongBenchPayload {
  return {
    _id: item._id,
    domain: item.domain,
    sub_domain: item.sub_domain,
    difficulty: item.difficulty,
    length: item.length,
    question: item.question,
    choices: {
      A: item.choice_A,
      B: item.choice_B,
      C: item.choice_C,
      D: item.choice_D,
    },
    answer: item.answer,
    context: item.context,
  };
}

export function getLongBenchTaskType(
  item: Pick<LongBenchItem, "domain" | "sub_domain">,
): LongBenchTaskType {
  const key = getSubdomainKey(item);
  const taskType = TASK_TYPE_BY_SUBDOMAIN[key];
  if (!taskType) {
    throw new Error(`Missing LongBench task-type mapping for ${key}`);
  }
  return taskType;
}

export function parseLongBenchPayload(prompt: string): LongBenchPayload {
  const parsed = JSON.parse(prompt) as Partial<LongBenchPayload>;
  const choices = (parsed.choices ?? {}) as Partial<Record<LongBenchAnswer, string>>;
  const answer = normalizeAnswerLetter(parsed.answer);

  if (
    typeof parsed._id !== "string" ||
    typeof parsed.domain !== "string" ||
    typeof parsed.sub_domain !== "string" ||
    typeof parsed.difficulty !== "string" ||
    typeof parsed.length !== "string" ||
    typeof parsed.question !== "string" ||
    typeof parsed.context !== "string" ||
    !answer ||
    typeof choices.A !== "string" ||
    typeof choices.B !== "string" ||
    typeof choices.C !== "string" ||
    typeof choices.D !== "string"
  ) {
    throw new Error("Invalid LongBench payload");
  }

  return {
    _id: parsed._id,
    domain: parsed.domain,
    sub_domain: parsed.sub_domain,
    difficulty: parsed.difficulty as LongBenchPayload["difficulty"],
    length: parsed.length as LongBenchPayload["length"],
    question: parsed.question,
    context: parsed.context,
    answer,
    choices: {
      A: choices.A,
      B: choices.B,
      C: choices.C,
      D: choices.D,
    },
  };
}

export function renderQuestionWithChoices(
  payload: Pick<LongBenchPayload, "question" | "choices">,
): string {
  return [
    `Question: ${payload.question}`,
    "",
    `A) ${payload.choices.A}`,
    `B) ${payload.choices.B}`,
    `C) ${payload.choices.C}`,
    `D) ${payload.choices.D}`,
  ].join("\n");
}

export function renderBudgeTask(payload: Pick<LongBenchPayload, "question" | "choices">): string {
  return [
    "Search the document to find evidence for or against each option. When you call finish, your answer must be exactly one letter: A, B, C, or D. No explanation.",
    "",
    renderQuestionWithChoices(payload),
  ].join("\n");
}

export function renderFullDumpUserPrompt(
  payload: Pick<LongBenchPayload, "context" | "question" | "choices">,
): string {
  return [payload.context, "", renderQuestionWithChoices(payload)].join("\n");
}

export function estimateFullDumpPromptTokens(
  payload: Pick<LongBenchPayload, "context" | "question" | "choices">,
): number {
  return estimateTokenCount(`${FULL_DUMP_SYSTEM_PROMPT}\n\n${renderFullDumpUserPrompt(payload)}`);
}

export function getFullDumpSystemPrompt(): string {
  return FULL_DUMP_SYSTEM_PROMPT;
}

export function extractLetter(text: string): LongBenchAnswer | undefined {
  // strip markdown bold before any matching
  const trimmed = text.trim().replace(/\*\*/g, "").toUpperCase();

  if (/^[ABCD]$/.test(trimmed)) {
    return trimmed as LongBenchAnswer;
  }

  // "Answer is A", "Option: B", "Choice is C"
  const labeled = trimmed.match(/(?:ANSWER|OPTION|CHOICE)\s*(?:IS|:)?\s*\(?([ABCD])\)?/);
  if (labeled) return labeled[1] as LongBenchAnswer;

  // "Correct letter: A", "Correct answer: B", "The correct letter is C"
  const correctLabel = trimmed.match(/CORRECT\s+(?:LETTER|ANSWER)\s*(?:IS|:)?\s*\(?([ABCD])\)?/);
  if (correctLabel) return correctLabel[1] as LongBenchAnswer;

  // letter at start of line: "A) ...", "(B)", "C."
  const leading = trimmed.match(/^\(?([ABCD])\)?(?:[\s.)-]|$)/);
  if (leading) return leading[1] as LongBenchAnswer;

  // single unambiguous standalone letter across whole text
  const standalone = Array.from(
    trimmed.matchAll(/\b([ABCD])\b/g),
    (match) => match[1] as LongBenchAnswer,
  );
  const unique = Array.from(new Set(standalone));
  if (unique.length === 1) return unique[0];

  return undefined;
}

export function normalizeProviderOutput(rawText: string): string {
  return extractLetter(rawText) ?? "?";
}

export function normalizeAnswerLetter(value: unknown): LongBenchAnswer | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  return upper === "A" || upper === "B" || upper === "C" || upper === "D"
    ? (upper as LongBenchAnswer)
    : undefined;
}

export function buildDocumentChunks(
  payload: Pick<LongBenchPayload, "_id" | "context">,
  options: { chunkSize?: number; overlap?: number } = {},
): CorpusChunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_RAG_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_RAG_CHUNK_OVERLAP;
  const rawChunks = splitByTokens(payload.context, chunkSize, { overlap });
  const chunks = rawChunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);

  if (chunks.length === 0) {
    return [
      {
        id: `${payload._id}#chunk:0`,
        filePath: payload._id,
        content: payload.context,
        tokenCount: estimateTokenCount(payload.context),
      },
    ];
  }

  return chunks.map((chunk, index) => ({
    id: `${payload._id}#chunk:${index}`,
    filePath: payload._id,
    content: chunk,
    tokenCount: estimateTokenCount(chunk),
  }));
}

export function renderRetrievedContext(chunks: CorpusChunk[]): string {
  if (chunks.length === 0) return "No retrieved context.";
  return chunks.map((chunk) => `--- ${chunk.id} ---\n${chunk.content}`).join("\n\n");
}

export function selectLongBenchSubset(
  items: LongBenchItem[],
  options: LongBenchSelectionOptions = {},
): LongBenchSelectionResult {
  const difficulty = new Set(options.difficulty ?? ["hard"]);
  const lengths = new Set(options.lengths ?? ["short", "medium"]);
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const maxFullDumpPromptTokens =
    options.maxFullDumpPromptTokens ?? DEFAULT_FULL_DUMP_MAX_PROMPT_TOKENS;

  const base = items.filter((item) => difficulty.has(item.difficulty) && lengths.has(item.length));
  const eligible = base.filter(
    (item) => estimateFullDumpPromptTokens(buildLongBenchPayload(item)) <= maxFullDumpPromptTokens,
  );
  const filteredOutByFitCap = base.filter(
    (item) => estimateFullDumpPromptTokens(buildLongBenchPayload(item)) > maxFullDumpPromptTokens,
  );

  const selected: LongBenchItem[] = [];

  const eligibleByDifficulty = groupBy(
    eligible.sort(compareLongBenchItems),
    (item) => item.difficulty,
  );
  const targetByDifficulty = allocateAcrossBuckets(
    Array.from(eligibleByDifficulty.entries()).map(([difficultyTier, tierItems]) => ({
      key: difficultyTier,
      size: tierItems.length,
    })),
    sampleSize,
  );

  for (const [difficultyTier, tierItems] of Array.from(eligibleByDifficulty.entries()).sort(
    ([left], [right]) => compareStrings(left, right),
  )) {
    const target = targetByDifficulty.get(difficultyTier) ?? 0;
    if (target <= 0) continue;
    selected.push(...selectWithinDifficultyTier(tierItems, target, options.taskTypeTargets));
  }

  return { selected, eligible, filteredOutByFitCap };
}

function selectWithinDifficultyTier(
  items: LongBenchItem[],
  target: number,
  taskTypeTargets?: Partial<Record<LongBenchTaskType, number>>,
): LongBenchItem[] {
  if (target <= 0 || items.length === 0) return [];

  const queuesBySubdomain = new Map<string, LongBenchItem[]>();
  for (const item of items) {
    const key = getSubdomainKey(item);
    const queue = queuesBySubdomain.get(key) ?? [];
    queue.push(item);
    queuesBySubdomain.set(key, queue);
  }

  const subdomainsByTaskType = new Map<LongBenchTaskType, string[]>();
  for (const taskType of LONGBENCH_TASK_TYPE_ORDER) {
    subdomainsByTaskType.set(taskType, []);
  }

  for (const key of Array.from(queuesBySubdomain.keys()).sort(compareStrings)) {
    const firstItem = queuesBySubdomain.get(key)?.[0];
    if (!firstItem) continue;
    const taskType = getLongBenchTaskType(firstItem);
    subdomainsByTaskType.get(taskType)?.push(key);
  }

  const selected: LongBenchItem[] = [];
  const selectedIds = new Set<string>();
  const selectedCountsByTaskType = new Map<LongBenchTaskType, number>();
  for (const taskType of LONGBENCH_TASK_TYPE_ORDER) {
    selectedCountsByTaskType.set(taskType, 0);
  }
  const subdomainFloorOrder = buildSubdomainFloorOrder(subdomainsByTaskType);
  const targetCountsByTaskType = resolveTaskTypeTargets(
    subdomainsByTaskType,
    queuesBySubdomain,
    Math.min(target, items.length),
    taskTypeTargets,
  );

  for (const subdomainKey of subdomainFloorOrder) {
    if (selected.length >= target) break;
    const next = queuesBySubdomain.get(subdomainKey)?.shift();
    if (!next || selectedIds.has(next._id)) continue;
    selected.push(next);
    selectedIds.add(next._id);
    incrementTaskTypeCount(selectedCountsByTaskType, getLongBenchTaskType(next));
  }

  const cyclingSubdomains = new Map<LongBenchTaskType, string[]>();
  for (const taskType of LONGBENCH_TASK_TYPE_ORDER) {
    cyclingSubdomains.set(taskType, [...(subdomainsByTaskType.get(taskType) ?? [])]);
  }

  while (selected.length < target) {
    let progressed = false;

    for (const taskType of getFillTaskTypeOrder(targetCountsByTaskType, selectedCountsByTaskType)) {
      const subdomainKeys = cyclingSubdomains.get(taskType) ?? [];
      const next = shiftNextAvailableItem(queuesBySubdomain, subdomainKeys);
      if (!next || selectedIds.has(next._id)) continue;
      selected.push(next);
      selectedIds.add(next._id);
      incrementTaskTypeCount(selectedCountsByTaskType, taskType);
      progressed = true;
      if (selected.length >= target) break;
    }

    if (!progressed) break;
  }

  return selected;
}

function resolveTaskTypeTargets(
  subdomainsByTaskType: Map<LongBenchTaskType, string[]>,
  queuesBySubdomain: Map<string, LongBenchItem[]>,
  total: number,
  requestedTargets?: Partial<Record<LongBenchTaskType, number>>,
): Map<LongBenchTaskType, number> | undefined {
  if (!requestedTargets) return undefined;

  const targets = new Map<LongBenchTaskType, number>();
  const minimums = new Map<LongBenchTaskType, number>();
  const capacities = new Map<LongBenchTaskType, number>();
  let assigned = 0;

  for (const taskType of LONGBENCH_TASK_TYPE_ORDER) {
    const subdomainKeys = subdomainsByTaskType.get(taskType) ?? [];
    const minimum = subdomainKeys.length;
    const capacity = subdomainKeys.reduce(
      (sum, key) => sum + (queuesBySubdomain.get(key)?.length ?? 0),
      0,
    );
    const requested = requestedTargets[taskType] ?? minimum;
    const initial = Math.min(capacity, Math.max(minimum, requested));

    minimums.set(taskType, minimum);
    capacities.set(taskType, capacity);
    targets.set(taskType, initial);
    assigned += initial;
  }

  if (assigned > total) {
    let overflow = assigned - total;
    for (const taskType of [...LONGBENCH_TASK_TYPE_ORDER].sort((left, right) => {
      const leftSurplus = (targets.get(left) ?? 0) - (minimums.get(left) ?? 0);
      const rightSurplus = (targets.get(right) ?? 0) - (minimums.get(right) ?? 0);
      return rightSurplus - leftSurplus || compareStrings(left, right);
    })) {
      if (overflow <= 0) break;
      const current = targets.get(taskType) ?? 0;
      const minimum = minimums.get(taskType) ?? 0;
      const removable = Math.max(0, current - minimum);
      if (removable === 0) continue;
      const decrement = Math.min(removable, overflow);
      targets.set(taskType, current - decrement);
      overflow -= decrement;
    }
  }

  if (assigned < total) {
    let remaining = total - assigned;
    for (const taskType of getRequestedTaskTypePriority(requestedTargets)) {
      if (remaining <= 0) break;
      const current = targets.get(taskType) ?? 0;
      const capacity = capacities.get(taskType) ?? 0;
      const requested = requestedTargets[taskType] ?? current;
      const desiredExtra = Math.max(0, requested - current);
      const grant = Math.min(remaining, desiredExtra, capacity - current);
      if (grant <= 0) continue;
      targets.set(taskType, current + grant);
      remaining -= grant;
    }

    while (remaining > 0) {
      let progressed = false;
      for (const taskType of getRequestedTaskTypePriority(requestedTargets)) {
        const current = targets.get(taskType) ?? 0;
        const capacity = capacities.get(taskType) ?? 0;
        if (current >= capacity) continue;
        targets.set(taskType, current + 1);
        remaining -= 1;
        progressed = true;
        if (remaining <= 0) break;
      }

      if (!progressed) break;
    }
  }

  return targets;
}

function getFillTaskTypeOrder(
  targetCountsByTaskType: Map<LongBenchTaskType, number> | undefined,
  selectedCountsByTaskType: Map<LongBenchTaskType, number>,
): LongBenchTaskType[] {
  if (!targetCountsByTaskType) {
    return LONGBENCH_TASK_TYPE_ORDER;
  }

  return [...LONGBENCH_TASK_TYPE_ORDER]
    .filter(
      (taskType) =>
        (targetCountsByTaskType.get(taskType) ?? 0) -
          (selectedCountsByTaskType.get(taskType) ?? 0) >
        0,
    )
    .sort((left, right) => {
      const leftRemaining =
        (targetCountsByTaskType.get(left) ?? 0) - (selectedCountsByTaskType.get(left) ?? 0);
      const rightRemaining =
        (targetCountsByTaskType.get(right) ?? 0) - (selectedCountsByTaskType.get(right) ?? 0);
      return rightRemaining - leftRemaining || compareStrings(left, right);
    });
}

function getRequestedTaskTypePriority(
  requestedTargets: Partial<Record<LongBenchTaskType, number>>,
): LongBenchTaskType[] {
  return [...LONGBENCH_TASK_TYPE_ORDER].sort((left, right) => {
    const leftRequested = requestedTargets[left] ?? 0;
    const rightRequested = requestedTargets[right] ?? 0;
    return rightRequested - leftRequested || compareStrings(left, right);
  });
}

function incrementTaskTypeCount(
  counts: Map<LongBenchTaskType, number>,
  taskType: LongBenchTaskType,
): void {
  counts.set(taskType, (counts.get(taskType) ?? 0) + 1);
}

function buildSubdomainFloorOrder(
  subdomainsByTaskType: Map<LongBenchTaskType, string[]>,
): string[] {
  const working = new Map<LongBenchTaskType, string[]>();
  for (const taskType of LONGBENCH_TASK_TYPE_ORDER) {
    working.set(taskType, [...(subdomainsByTaskType.get(taskType) ?? [])]);
  }

  const ordered: string[] = [];
  while (true) {
    let progressed = false;

    for (const taskType of LONGBENCH_TASK_TYPE_ORDER) {
      const next = working.get(taskType)?.shift();
      if (!next) continue;
      ordered.push(next);
      progressed = true;
    }

    if (!progressed) return ordered;
  }
}

function shiftNextAvailableItem(
  queuesBySubdomain: Map<string, LongBenchItem[]>,
  subdomainKeys: string[],
): LongBenchItem | undefined {
  for (let index = 0; index < subdomainKeys.length; index += 1) {
    const subdomainKey = subdomainKeys.shift();
    if (!subdomainKey) return undefined;
    subdomainKeys.push(subdomainKey);

    const queue = queuesBySubdomain.get(subdomainKey);
    const next = queue?.shift();
    if (next) return next;
  }

  return undefined;
}

function allocateAcrossBuckets(
  buckets: Array<{ key: string; size: number }>,
  total: number,
): Map<string, number> {
  const eligibleBuckets = buckets.filter((bucket) => bucket.size > 0);
  const allocation = new Map<string, number>();

  if (eligibleBuckets.length === 0 || total <= 0) return allocation;

  const totalSize = eligibleBuckets.reduce((sum, bucket) => sum + bucket.size, 0);
  const provisional = eligibleBuckets.map((bucket) => {
    const exact = (bucket.size / totalSize) * total;
    const floor = Math.min(bucket.size, Math.floor(exact));
    return { ...bucket, exact, floor, remainder: exact - floor };
  });

  let assigned = 0;
  for (const bucket of provisional) {
    allocation.set(bucket.key, bucket.floor);
    assigned += bucket.floor;
  }

  let remaining = Math.min(total, totalSize) - assigned;
  for (const bucket of provisional
    .slice()
    .sort(
      (left, right) => right.remainder - left.remainder || compareStrings(left.key, right.key),
    )) {
    if (remaining <= 0) break;
    const current = allocation.get(bucket.key) ?? 0;
    if (current >= bucket.size) continue;
    allocation.set(bucket.key, current + 1);
    remaining -= 1;
  }

  return allocation;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
}

function getSubdomainKey(item: Pick<LongBenchItem, "domain" | "sub_domain">): string {
  return `${item.domain} / ${item.sub_domain}`;
}

function compareLongBenchItems(left: LongBenchItem, right: LongBenchItem): number {
  return (
    compareStrings(left.domain, right.domain) ||
    compareStrings(left.sub_domain, right.sub_domain) ||
    compareStrings(left.length, right.length) ||
    compareStrings(left._id, right._id)
  );
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
