import { generateText } from "ai";
import type { LanguageModel } from "ai";
import safeStableStringify from "safe-stable-stringify";
import type { RuntimeTrace, SubcallTraceNode, ToolCallRecord } from "./types.ts";

const HANDOFF_SYSTEM_PROMPT = `You turn Budge research output into a briefing for a downstream action agent.
Return Markdown only. Do not return JSON. Do not wrap the response in code fences.
Use exactly this structure:
# Context

## Task
...

## Findings
### <sourceName>
- <path>: <finding>

## Coverage
...

## Confidence
High | Medium | Low. <brief rationale>

## Gaps
- ...
Omit the Gaps section entirely if there are no meaningful gaps.
Write the Coverage section based only on what the trace shows was actually accessed.
Do not invent skipped counts.
Use language like "X files read across Y sources", "Worker calls covered: [...]", and "The following were listed but not read: [...]" when supported by the trace.
If you cannot determine coverage confidently, say "Coverage limited to files listed in trace."
Base findings on the final answer plus the trace evidence. Keep them concrete and source-aware.`;

export async function buildHandoff(opts: {
  task: string;
  answer: string;
  trace: RuntimeTrace<any>;
  worker: LanguageModel;
  system?: string;
}): Promise<string> {
  const { task, answer, trace, worker } = opts;

  const result = await generateText({
    model: worker,
    system: HANDOFF_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildHandoffInput({ task, answer, trace }) }],
  });

  const handoff = result.text.trim();
  if (!handoff) {
    throw new Error("Worker returned empty handoff");
  }

  return [opts.system ? `# System\n${opts.system}` : null, handoff].filter(Boolean).join("\n\n");
}

function buildHandoffInput(opts: {
  task: string;
  answer: string;
  trace: RuntimeTrace<any>;
}): string {
  const { task, answer, trace } = opts;
  const readPaths = collectReadPaths(trace);
  const listedPaths = collectListedPaths(trace.tree.toolCalls);
  const listedNotRead = collectListedButNotRead(listedPaths, readPaths);
  const subcallsBySource = groupSubcallsBySource(trace.tree.children);
  const totalReadPaths = Array.from(readPaths.values()).reduce((sum, paths) => sum + paths.size, 0);
  const sourceNames = Array.from(new Set([...readPaths.keys(), ...listedPaths.keys()]));

  return [
    "Task:",
    task,
    "",
    "Final answer:",
    answer,
    "",
    "Trace summary:",
    `- Total subcalls: ${trace.totalSubcalls}`,
    `- Total tokens: ${trace.totalTokens}`,
    `- Duration ms: ${trace.durationMs}`,
    `- Sources with observable access: ${sourceNames.length === 0 ? "none" : sourceNames.join(", ")}`,
    "",
    "Coverage hints derived from the trace:",
    `- Files read across sources: ${totalReadPaths}`,
    `- Sources read from: ${readPaths.size}`,
    `- Worker call paths: ${trace.tree.children.length === 0 ? "none" : trace.tree.children.map((child) => `${child.source}/${child.path}`).join(", ")}`,
    `- ${formatListedButNotRead(listedNotRead)}`,
    "",
    "Reads by source:",
    formatSourcePathMap(readPaths),
    "",
    "List results by source:",
    formatSourcePathMap(listedPaths),
    "",
    "Focused worker calls:",
    formatSubcalls(subcallsBySource),
    "",
    "Root tool calls:",
    formatToolCalls(trace.tree.toolCalls),
  ].join("\n");
}

export function buildFallbackHandoff(opts: {
  task: string;
  answer: string;
  trace: RuntimeTrace<any>;
  system?: string;
}): string {
  const readPaths = collectReadPaths(opts.trace);
  const listedNotRead = collectListedButNotRead(
    collectListedPaths(opts.trace.tree.toolCalls),
    readPaths,
  );
  const totalReadPaths = Array.from(readPaths.values()).reduce((sum, paths) => sum + paths.size, 0);
  const sourceNames = Array.from(readPaths.keys());
  const coverageParts = [`${totalReadPaths} files read across ${sourceNames.length} sources`];

  if (opts.trace.tree.children.length > 0) {
    coverageParts.push(
      `Worker calls covered: ${opts.trace.tree.children.map((child) => `${child.source}/${child.path}`).join(", ")}`,
    );
  }

  const listedButNotReadEntries = formatListedButNotReadEntries(listedNotRead);
  if (listedButNotReadEntries) {
    coverageParts.push(`The following were listed but not read: ${listedButNotReadEntries}`);
  }

  return [
    opts.system ? `# System\n${opts.system}` : null,
    "# Context",
    "",
    "## Task",
    opts.task,
    "",
    "## Findings",
    "### synthesis",
    `- final-answer: ${truncate(opts.answer, 200) || "No answer captured."}`,
    "",
    "## Coverage",
    coverageParts.join(". "),
    "",
    "## Confidence",
    "Medium. Generated from the trace and final answer with limited synthesis detail.",
  ]
    .filter(Boolean)
    .join("\n");
}

function collectReadPaths(trace: RuntimeTrace<any>): Map<string, Set<string>> {
  const readPaths = new Map<string, Set<string>>();

  for (const [source, paths] of Object.entries(trace.sourcesAccessed)) {
    for (const path of paths ?? []) {
      addPath(readPaths, source, path);
    }
  }

  return readPaths;
}

function collectListedPaths(toolCalls: ToolCallRecord[]): Map<string, Set<string>> {
  const listedPaths = new Map<string, Set<string>>();

  for (const toolCall of toolCalls) {
    if (toolCall.tool !== "list_source") continue;

    const source = getStringArg(toolCall, "source");
    if (!source) continue;

    for (const path of parseListedPaths(toolCall.result)) {
      addPath(listedPaths, source, path);
    }
  }

  return listedPaths;
}

function collectListedButNotRead(
  listedPaths: Map<string, Set<string>>,
  readPaths: Map<string, Set<string>>,
): Map<string, string[]> {
  const listedButNotRead = new Map<string, string[]>();

  for (const [source, paths] of listedPaths) {
    const reads = readPaths.get(source) ?? new Set<string>();
    const remaining = Array.from(paths)
      .filter((path) => !reads.has(path))
      .sort();
    if (remaining.length > 0) {
      listedButNotRead.set(source, remaining);
    }
  }

  return listedButNotRead;
}

function groupSubcallsBySource(children: SubcallTraceNode[]): Map<string, SubcallTraceNode[]> {
  const grouped = new Map<string, SubcallTraceNode[]>();

  for (const child of children) {
    const existing = grouped.get(child.source);
    if (existing) {
      existing.push(child);
      continue;
    }
    grouped.set(child.source, [child]);
  }

  return grouped;
}

function formatSourcePathMap(pathMap: Map<string, Set<string>>): string {
  if (pathMap.size === 0) return "- none";

  return Array.from(pathMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, paths]) => {
      const values = Array.from(paths).sort();
      return `- ${source}: ${values.length === 0 ? "none" : values.join(", ")}`;
    })
    .join("\n");
}

function formatListedButNotRead(listedButNotRead: Map<string, string[]>): string {
  const entries = formatListedButNotReadEntries(listedButNotRead);

  if (!entries) {
    return "Coverage limited to files listed in trace.";
  }

  return `The following were listed but not read: ${entries}`;
}

function formatListedButNotReadEntries(listedButNotRead: Map<string, string[]>): string | null {
  if (listedButNotRead.size === 0) {
    return null;
  }

  return Array.from(listedButNotRead.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, paths]) => `${source}: ${paths.join(", ")}`)
    .join("; ");
}

function formatSubcalls(subcallsBySource: Map<string, SubcallTraceNode[]>): string {
  if (subcallsBySource.size === 0) return "- none";

  return Array.from(subcallsBySource.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, nodes]) => {
      const lines = nodes
        .map(
          (node) =>
            `  - ${node.path}: task=${safeStableStringify(node.task) ?? '""'}, answer=${safeStableStringify(truncate(node.answer, 200)) ?? '""'}`,
        )
        .join("\n");
      return `- ${source}:\n${lines}`;
    })
    .join("\n");
}

function formatToolCalls(toolCalls: ToolCallRecord[]): string {
  const meaningful = toolCalls.filter(
    (toolCall) =>
      toolCall.tool === "run_subcall" ||
      toolCall.tool === "run_subcalls" ||
      toolCall.tool === "finish",
  );

  if (meaningful.length === 0) return "- none";

  return meaningful
    .map((toolCall) => {
      const source = getStringArg(toolCall, "source");
      const path = getStringArg(toolCall, "path");
      const location = source ? `${source}${path ? `/${path}` : ""}` : "n/a";
      return `- ${toolCall.tool} @ ${location}: ${safeStableStringify(truncate(toolCall.result, 200)) ?? '""'}`;
    })
    .join("\n");
}

function parseListedPaths(result: string): string[] {
  const trimmed = result.trim();
  if (!trimmed || trimmed === "(empty)" || trimmed.startsWith("[Error listing ")) {
    return [];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getStringArg(toolCall: ToolCallRecord, key: string): string | undefined {
  const value = toolCall.args[key];
  return typeof value === "string" ? value : undefined;
}

function addPath(pathMap: Map<string, Set<string>>, source: string, path: string): void {
  const existing = pathMap.get(source);
  if (existing) {
    existing.add(path);
    return;
  }

  pathMap.set(source, new Set([path]));
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
