import { randomUUID } from "node:crypto";
import stringify from "safe-stable-stringify";
import type {
  AllowedContext,
  AnyInput,
  BudgetStrategyFn,
  Definition,
  InputSchema,
  InputSource,
  PolicyRecord,
  PromptTrace,
  RenderContext,
  ResolverSource,
  InferSources,
  Resolution,
} from "./types.ts";
import { isRagItems } from "./rag.ts";
import { buildWaves, executeWaves, validateSourceDependencies } from "./graph.ts";
import { applyPolicies } from "./policies.ts";
import { estimateTokens, normalizeBudget, packChunks, serialize } from "./pack.ts";
import { buildTrace } from "./trace.ts";
import type { SourceTiming } from "./trace.ts";

function isInputSource(source: unknown): source is InputSource<string> {
  return (
    typeof source === "object" &&
    source !== null &&
    "_type" in source &&
    (source as { _type?: unknown })._type === "input"
  );
}

function isResolverSource(source: unknown): source is ResolverSource<unknown> {
  return (
    typeof source === "object" &&
    source !== null &&
    "resolve" in source &&
    typeof (source as { resolve?: unknown }).resolve === "function"
  );
}

function isRagEnvelope(value: unknown): value is { _type: "rag" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "_type" in value &&
    (value as { _type?: unknown })._type === "rag"
  );
}

async function validateInput<TResolveInput extends AnyInput, TInput extends AnyInput>(
  schema: InputSchema<TResolveInput, TInput>,
  input: TResolveInput,
  windowId: string,
): Promise<TInput> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Input validation failed for context window "${windowId}": ${details}`);
  }

  return result.value;
}

/**
 * Compute the token cost of serializing a collection of values as JSON.
 */
function computeJsonValueTokens(values: Iterable<unknown>): number {
  let total = 0;
  for (const value of values) {
    const str =
      value === null || value === undefined
        ? ""
        : (stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)) ??
          "");
    total += estimateTokens(str);
  }
  return total;
}

/**
 * Compute the raw JSON token cost of all resolved sources.
 * Used to calculate the full-resolution compression ratio when rendering is enabled.
 */
function computeRawContextTokens(resolvedRaw: Map<string, unknown>): number {
  return computeJsonValueTokens(resolvedRaw.values());
}

/**
 * Compute the raw JSON token cost of the final context that render functions can read.
 * This excludes policy-gated or budget-dropped sources, but includes derived values.
 */
function computeIncludedContextTokens(context: Record<string, unknown>): number {
  return computeJsonValueTokens(Object.values(context));
}

function computeCompressionRatio(totalTokens: number, baselineTokens: number): number {
  if (baselineTokens <= 0) {
    return 0;
  }

  return Math.max(0, 1 - totalTokens / baselineTokens);
}

interface RenderState {
  rawContext: Record<string, unknown>;
  proxyCache: WeakMap<object, unknown>;
  slotCache: WeakMap<object, string>;
  slotValues: Map<string, unknown>;
  slotNonce: string;
  slotCounter: number;
}

interface RenderedOutput {
  system?: string;
  prompt?: string;
}

type RenderField = string | ((context: Record<string, unknown>) => string);

function isRenderableObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function createSlotToken(state: RenderState, value: object): string {
  const existing = state.slotCache.get(value);
  if (existing) {
    return existing;
  }

  const token = `\u001fPOLO_SLOT_${state.slotNonce}_${state.slotCounter++}\u001f`;
  state.slotCache.set(value, token);
  state.slotValues.set(token, value);
  return token;
}

function wrapRenderableValue(value: unknown, state: RenderState, isRoot = false): unknown {
  if (!isRenderableObject(value)) {
    return value;
  }

  const cached = state.proxyCache.get(value);
  if (cached !== undefined) {
    return cached;
  }

  const proxy = new Proxy(value, {
    get(target, prop, receiver) {
      if (isRoot && prop === "raw") {
        return state.rawContext;
      }

      if (prop === Symbol.toPrimitive) {
        return () => createSlotToken(state, target);
      }

      if (prop === "toString") {
        return () => createSlotToken(state, target);
      }

      if (prop === "valueOf") {
        return () => createSlotToken(state, target);
      }

      const result = Reflect.get(target, prop, receiver);
      return wrapRenderableValue(result, state);
    },
    has(target, prop) {
      if (isRoot && prop === "raw") {
        return true;
      }

      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      if (isRoot && !keys.includes("raw")) {
        keys.push("raw");
      }
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (isRoot && prop === "raw") {
        return {
          configurable: true,
          enumerable: false,
          writable: false,
          value: state.rawContext,
        };
      }

      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  state.proxyCache.set(value, proxy);
  return proxy;
}

function materializeText(text: string, slotValues: Map<string, unknown>): string {
  let output = text;
  for (const [token, value] of slotValues) {
    output = output.split(token).join(serialize(value));
  }
  return output;
}

function renderField(
  field: RenderField | undefined,
  renderContext: RenderContext<Record<string, unknown>, Record<string, unknown>, []>,
  state: RenderState,
): string | undefined {
  if (field === undefined) {
    return undefined;
  }

  const text =
    typeof field === "function" ? field(renderContext as Record<string, unknown>) : field;
  return materializeText(text, state.slotValues);
}

function renderOutput(
  system: RenderField | undefined,
  prompt: RenderField | undefined,
  rawContext: Record<string, unknown>,
): RenderedOutput {
  const state: RenderState = {
    rawContext,
    proxyCache: new WeakMap(),
    slotCache: new WeakMap(),
    slotValues: new Map(),
    slotNonce: randomUUID(),
    slotCounter: 0,
  };

  const renderContext = wrapRenderableValue(rawContext, state, true) as RenderContext<
    Record<string, unknown>,
    Record<string, unknown>,
    []
  >;

  return {
    system: renderField(system, renderContext, state),
    prompt: renderField(prompt, renderContext, state),
  };
}

function countRenderedTokens(output: RenderedOutput): number {
  return estimateTokens(output.system ?? "") + estimateTokens(output.prompt ?? "");
}

function validateDerivedContextKeys(
  sources: Record<string, unknown>,
  derived: Record<string, unknown>,
): void {
  for (const key of Object.keys(derived)) {
    if (key === "raw") {
      throw new TypeError('derive() cannot return the reserved context key "raw".');
    }

    if (key in sources) {
      throw new TypeError(`derive() cannot overwrite source key "${key}".`);
    }
  }
}

export async function resolveDefinition<
  TInput extends AnyInput,
  TSourceMap extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TPrefer extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TResolveInput extends AnyInput = TInput,
>(
  definition: Definition<TInput, TSourceMap, TDerived, TRequired, TPrefer, TResolveInput>,
  input: TResolveInput,
): Promise<Resolution<InferSources<TInput, TSourceMap>, TDerived, TRequired>> {
  const startedAt = new Date();
  const {
    _id: windowId,
    _inputSchema: inputSchema,
    _sources: sourceMap,
    _derive: deriveFn,
    _policies: policies,
    _system: systemField,
    _prompt: promptField,
  } = definition;
  const normalizedInput = await validateInput(inputSchema, input, windowId);

  // --- build execution plan ---
  const sourceKeysById = validateSourceDependencies(sourceMap, "source map");
  const waves = buildWaves(sourceMap, "source map", sourceKeysById);

  // --- execute sources wave by wave ---
  const sourceTimings: SourceTiming[] = [];

  const resolvedRaw = await executeWaves(
    sourceMap,
    normalizedInput,
    waves,
    sourceKeysById,
    windowId,
    (key, value, durationMs) => {
      const source = sourceMap[key]!;
      const type = isInputSource(source) ? "input" : isRagItems(value) ? "rag" : "value";

      sourceTimings.push({
        key,
        type,
        tags: isInputSource(source)
          ? source._tags
          : isResolverSource(source)
            ? (source.tags ?? [])
            : [],
        resolvedAt: new Date(),
        durationMs,
      });
    },
  );

  // --- derive ---
  const resolvedForDerive = Object.fromEntries(resolvedRaw) as InferSources<TInput, TSourceMap>;
  const derived: TDerived = deriveFn ? deriveFn(resolvedForDerive) : ({} as TDerived);
  validateDerivedContextKeys(resolvedForDerive, derived);

  // --- apply policies ---
  const { maxTokens: budget, strategyFn, strategyName } = normalizeBudget(policies.budget);
  let budgetCandidates = 0;
  let budgetSelected = 0;
  const { allowed, records: policyRecords } = applyPolicies<
    InferSources<TInput, TSourceMap>,
    TDerived,
    TRequired,
    TPrefer
  >(resolvedRaw, derived, policies, windowId);

  // Excluded chunk sources are resolved before policies run. Attach redacted
  // chunk records so source-level trace entries remain self-contained and
  // clearly indicate policy exclusion.
  const excludedChunkKeys = new Set(
    policyRecords.filter((record) => record.action === "excluded").map((record) => record.source),
  );

  for (const key of excludedChunkKeys) {
    const raw = resolvedRaw.get(key);
    if (!isRagItems(raw)) {
      continue;
    }

    const timing = sourceTimings.find((t) => t.key === key);
    if (timing && timing.itemRecords === undefined) {
      timing.itemRecords = raw.items.map((chunk) => ({
        content: "",
        score: chunk.score,
        included: false,
        reason: "excluded",
      }));
    }
  }

  const requiredKeys = new Set((policies.require ?? []).map(String));
  const preferredKeys = new Set((policies.prefer ?? []).map(String));
  const declaredRagSourceKeys = new Set(
    Object.entries(sourceMap)
      .filter(([, source]) => isResolverSource(source) && source._sourceKind === "rag")
      .map(([key]) => key),
  );

  if (systemField !== undefined || promptField !== undefined) {
    // --- render path: render-measure-fit ---
    const resolution = resolveWithRendering({
      resolvedRaw,
      derived,
      allowed,
      policyRecords,
      requiredKeys,
      preferredKeys,
      sourceTimings,
      budget,
      strategyFn,
      declaredRagSourceKeys,
      system: systemField as RenderField | undefined,
      prompt: promptField as RenderField | undefined,
      windowId,
    });

    const rawContextTokens = computeRawContextTokens(resolvedRaw);
    const includedContextTokens = computeIncludedContextTokens(resolution.context);
    const systemTokens = estimateTokens(resolution.system ?? "");
    const promptTokens = estimateTokens(resolution.prompt ?? "");
    const totalTokens = systemTokens + promptTokens;

    const promptTrace: PromptTrace = {
      systemTokens,
      promptTokens,
      totalTokens,
      rawContextTokens,
      includedContextTokens,
      compressionRatio: computeCompressionRatio(totalTokens, rawContextTokens),
      includedCompressionRatio: computeCompressionRatio(totalTokens, includedContextTokens),
    };

    const completedAt = new Date();
    const trace = buildTrace({
      windowId,
      startedAt,
      completedAt,
      sourceTimings: resolution.sourceTimings,
      policyRecords: resolution.policyRecords,
      derived,
      budgetMax: budget === Infinity ? 0 : budget,
      budgetUsed: totalTokens,
      strategyName,
      budgetCandidates: resolution.budgetCandidates,
      budgetSelected: resolution.budgetSelected,
      promptTrace,
    });

    return {
      context: resolution.context as AllowedContext<
        InferSources<TInput, TSourceMap>,
        TDerived,
        TRequired
      >,
      system: resolution.system,
      prompt: resolution.prompt,
      trace,
    };
  }

  // --- non-render path: per-source TOON estimation (existing behavior) ---
  const context: Record<string, unknown> = {};
  let budgetUsed = 0;

  // Iterate in priority order so required sources consume budget first,
  // then preferred, then default-included. This ensures budget gating
  // drops lower-priority sources before higher-priority ones.
  const orderedKeys = [
    ...(policies.require ?? []).map(String).filter((k) => allowed.has(k)),
    ...(policies.prefer ?? []).map(String).filter((k) => allowed.has(k) && !requiredKeys.has(k)),
    ...[...allowed].filter((k) => !requiredKeys.has(k) && !preferredKeys.has(k)),
  ];

  for (const key of orderedKeys) {
    const raw = resolvedRaw.get(key);

    if (isRagItems(raw)) {
      const packed = requiredKeys.has(key)
        ? packChunks(raw, Infinity, strategyFn)
        : packChunks(raw, budget === Infinity ? Infinity : budget - budgetUsed, strategyFn);

      budgetCandidates += raw.items.length;
      budgetSelected += packed.included.length;

      // Attach chunk records to the source timing entry
      const timing = sourceTimings.find((t) => t.key === key);
      if (timing) timing.itemRecords = packed.records;

      if (!requiredKeys.has(key) && raw.items.length > 0 && packed.included.length === 0) {
        policyRecords.push({ source: key, action: "dropped", reason: "over_budget" });
        continue;
      }

      budgetUsed += packed.tokensUsed;
      context[key] = packed.included;
    } else {
      if (declaredRagSourceKeys.has(key) && isRagEnvelope(raw)) {
        throw new TypeError(
          `Source "${key}" resolved malformed rag items. Expected Chunk[] items with string content.`,
        );
      }

      const tokens = estimateTokens(serialize(raw));

      if (!requiredKeys.has(key) && budget !== Infinity && budgetUsed + tokens > budget) {
        policyRecords.push({ source: key, action: "dropped", reason: "over_budget" });
        continue;
      }

      budgetUsed += tokens;
      context[key] = raw;
    }
  }

  // Derived values are computed once from the full resolved source set before
  // policy and budget filtering. They intentionally remain stable even if
  // later source drops remove the raw inputs they were derived from.
  Object.assign(context, derived);

  // --- build trace ---
  const completedAt = new Date();
  const trace = buildTrace({
    windowId,
    startedAt,
    completedAt,
    sourceTimings,
    policyRecords,
    derived,
    budgetMax: budget === Infinity ? 0 : budget,
    budgetUsed,
    strategyName,
    budgetCandidates,
    budgetSelected,
  });

  return {
    context: context as AllowedContext<InferSources<TInput, TSourceMap>, TDerived, TRequired>,
    trace,
  };
}

interface RenderResolutionResult {
  context: Record<string, unknown>;
  system?: string;
  prompt?: string;
  policyRecords: PolicyRecord[];
  sourceTimings: SourceTiming[];
  budgetCandidates: number;
  budgetSelected: number;
}

/**
 * Render the configured system/prompt strings with the current context, then iteratively drop the
 * lowest-priority
 * non-required sources and re-render until the output fits the budget.
 *
 * Drop order (ascending priority = first to drop):
 *   1. default-included sources (not in require or prefer)
 *   2. preferred sources
 *   Required sources are never dropped.
 *
 * After exhausting whole-source drops, trim the lowest-score chunks from rag sources
 * one at a time until the prompt fits.
 */
function resolveWithRendering(options: {
  resolvedRaw: Map<string, unknown>;
  derived: Record<string, unknown>;
  allowed: Set<string>;
  policyRecords: PolicyRecord[];
  requiredKeys: Set<string>;
  preferredKeys: Set<string>;
  sourceTimings: SourceTiming[];
  budget: number;
  strategyFn: BudgetStrategyFn;
  declaredRagSourceKeys: Set<string>;
  system?: RenderField;
  prompt?: RenderField;
  windowId: string;
}): RenderResolutionResult {
  const {
    resolvedRaw,
    derived,
    allowed,
    policyRecords,
    requiredKeys,
    preferredKeys,
    sourceTimings,
    budget,
    strategyFn,
    declaredRagSourceKeys,
    system,
    prompt,
  } = options;

  // Build mutable context with all non-excluded sources (chunks included in full)
  const context: Record<string, unknown> = {};
  // Track chunk arrays separately so we can trim them
  const chunkContextKeys = new Set<string>();
  let templateCandidates = 0;

  for (const key of allowed) {
    const raw = resolvedRaw.get(key);
    if (isRagItems(raw)) {
      templateCandidates += raw.items.length;
      chunkContextKeys.add(key);

      if (budget === Infinity) {
        // No budget configured — preserve original insertion order
        context[key] = [...raw.items];
        const timing = sourceTimings.find((t) => t.key === key);
        if (timing) {
          timing.itemRecords = raw.items.map((c) => ({
            content: c.content,
            score: c.score,
            included: true,
          }));
        }
      } else {
        // Pre-sort chunks using the strategy's ordering so that Phase 2
        // trimming drops the least-valuable-per-strategy chunks first.
        const ranked = strategyFn(raw.items, { budget: Infinity, estimateTokens });
        context[key] = [...ranked.included];
        const timing = sourceTimings.find((t) => t.key === key);
        if (timing) {
          timing.itemRecords = ranked.records;
        }
      }
    } else {
      if (declaredRagSourceKeys.has(key) && isRagEnvelope(raw)) {
        throw new TypeError(
          `Source "${key}" resolved malformed rag items. Expected Chunk[] items with string content.`,
        );
      }

      context[key] = raw;
    }
  }

  // Derived values are computed once from the full resolved source set before
  // policy and budget fitting. They intentionally remain stable even if later
  // source drops or chunk trimming remove the raw inputs they were derived from.
  Object.assign(context, derived);

  // If no budget, skip fitting
  if (budget === Infinity) {
    const rendered = renderOutput(system, prompt, context);
    const selectedCount = [...chunkContextKeys].reduce((sum, key) => {
      const chunks = context[key] as unknown[];
      return sum + (chunks?.length ?? 0);
    }, 0);
    return {
      context,
      system: rendered.system,
      prompt: rendered.prompt,
      policyRecords,
      sourceTimings,
      budgetCandidates: templateCandidates,
      budgetSelected: selectedCount,
    };
  }

  // Partition droppable sources: non-chunk sources are dropped whole, chunk sources are trimmed.
  const defaultKeys = [...allowed].filter((k) => !requiredKeys.has(k) && !preferredKeys.has(k));
  const preferKeys = [...preferredKeys].filter((k) => allowed.has(k));

  // Non-chunk droppable queues (default-included first, then preferred)
  const droppableNonChunk = [
    ...defaultKeys.filter((k) => !chunkContextKeys.has(k)),
    ...preferKeys.filter((k) => !chunkContextKeys.has(k)),
  ];
  // Chunk droppable queues for whole-source drops (after trimming exhausted)
  const droppableChunkWhole = [
    ...defaultKeys.filter((k) => chunkContextKeys.has(k)),
    ...preferKeys.filter((k) => chunkContextKeys.has(k)),
  ];

  let rendered = renderOutput(system, prompt, context);

  // Phase 1: drop whole non-chunk sources (default-included before preferred)
  while (countRenderedTokens(rendered) > budget && droppableNonChunk.length > 0) {
    const keyToDrop = droppableNonChunk.shift()!;
    policyRecords.push({ source: keyToDrop, action: "dropped", reason: "over_budget" });
    delete context[keyToDrop];
    rendered = renderOutput(system, prompt, context);
  }

  // Phase 2: trim chunks one-at-a-time from rag sources.
  // Items are already pre-sorted by the budget strategy (most valuable first),
  // so dropping the last element removes the least-valuable-per-strategy chunk.
  if (countRenderedTokens(rendered) > budget) {
    let trimmed = true;
    while (countRenderedTokens(rendered) > budget && trimmed) {
      trimmed = false;

      // Find a non-required chunk source still in context that has more than one chunk
      for (const key of chunkContextKeys) {
        if (requiredKeys.has(key)) continue;
        if (!(key in context)) continue;
        const chunks = context[key] as Array<{ content: string; score?: number }>;
        if (chunks.length <= 1) continue;

        // Drop the strategy's least-valuable chunk (last in pre-sorted order)
        const dropped = chunks.pop()!;

        // Update chunk records in timing — match by content + score, searching
        // from the end so that duplicates are marked in reverse strategy order
        const timing = sourceTimings.find((t) => t.key === key);
        if (timing?.itemRecords) {
          const record = timing.itemRecords.findLast(
            (r) => r.included && r.content === dropped.content && r.score === dropped.score,
          );
          if (record) {
            record.included = false;
            record.reason = "chunk_trimmed_over_budget";
          }
        }

        rendered = renderOutput(system, prompt, context);
        trimmed = true;
        break;
      }
    }
  }

  // Phase 3: drop whole chunk sources if still over budget (last resort)
  while (countRenderedTokens(rendered) > budget && droppableChunkWhole.length > 0) {
    const keyToDrop = droppableChunkWhole.shift()!;
    policyRecords.push({
      source: keyToDrop,
      action: "dropped",
      reason: "over_budget",
    });
    const timing = sourceTimings.find((t) => t.key === keyToDrop);
    if (timing?.itemRecords) {
      for (const record of timing.itemRecords) {
        record.included = false;
        record.reason = "source_dropped_over_budget";
      }
    }
    delete context[keyToDrop];
    rendered = renderOutput(system, prompt, context);
  }

  const selectedCount = [...chunkContextKeys].reduce((sum, key) => {
    const chunks = context[key] as unknown[] | undefined;
    return sum + (chunks?.length ?? 0);
  }, 0);
  return {
    context,
    system: rendered.system,
    prompt: rendered.prompt,
    policyRecords,
    sourceTimings,
    budgetCandidates: templateCandidates,
    budgetSelected: selectedCount,
  };
}
