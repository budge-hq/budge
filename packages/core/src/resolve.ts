import { randomUUID } from "node:crypto";
import stringify from "safe-stable-stringify";
import type {
  AllowedContext,
  AnyInput,
  Definition,
  InputSchema,
  InputSource,
  PolicyRecord,
  ResolverSource,
  InferSources,
  PromptOutput,
  PromptTrace,
  Resolution,
  TemplateContext,
} from "./types.ts";
import { isChunks } from "./chunks.ts";
import { buildWaves, executeWaves, validateSourceDependencies } from "./graph.ts";
import { applyPolicies } from "./policies.ts";
import { estimateTokens, packChunks, serialize } from "./pack.ts";
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

function isChunkEnvelope(value: unknown): value is { _type: "chunks" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "_type" in value &&
    (value as { _type?: unknown })._type === "chunks"
  );
}

async function validateInput<TResolveInput extends AnyInput, TInput extends AnyInput>(
  schema: InputSchema<TResolveInput, TInput>,
  input: TResolveInput,
  taskId: string,
): Promise<TInput> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Input validation failed for task "${taskId}": ${details}`);
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
 * Used to calculate the full-resolution compression ratio when a template is present.
 */
function computeRawContextTokens(resolvedRaw: Map<string, unknown>): number {
  return computeJsonValueTokens(resolvedRaw.values());
}

/**
 * Compute the raw JSON token cost of the final context that the template can read.
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

interface TemplateRenderState {
  rawContext: Record<string, unknown>;
  proxyCache: WeakMap<object, unknown>;
  slotCache: WeakMap<object, string>;
  slotValues: Map<string, unknown>;
  slotNonce: string;
  slotCounter: number;
}

function isRenderableObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function createSlotToken(state: TemplateRenderState, value: object): string {
  const existing = state.slotCache.get(value);
  if (existing) {
    return existing;
  }

  const token = `\u001fPOLO_SLOT_${state.slotNonce}_${state.slotCounter++}\u001f`;
  state.slotCache.set(value, token);
  state.slotValues.set(token, value);
  return token;
}

function wrapRenderableValue(value: unknown, state: TemplateRenderState, isRoot = false): unknown {
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

function renderTemplate(
  templateFn: (args: { context: Record<string, unknown> }) => PromptOutput,
  rawContext: Record<string, unknown>,
): PromptOutput {
  const state: TemplateRenderState = {
    rawContext,
    proxyCache: new WeakMap(),
    slotCache: new WeakMap(),
    slotValues: new Map(),
    slotNonce: randomUUID(),
    slotCounter: 0,
  };

  const renderContext = wrapRenderableValue(rawContext, state, true) as TemplateContext<
    Record<string, unknown>,
    Record<string, unknown>,
    []
  >;
  const prompt = templateFn({ context: renderContext as Record<string, unknown> });

  return {
    system: materializeText(prompt.system, state.slotValues),
    prompt: materializeText(prompt.prompt, state.slotValues),
  };
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
    _id: taskId,
    _inputSchema: inputSchema,
    _sources: sourceMap,
    _derive: deriveFn,
    _policies: policies,
    _template: templateFn,
  } = definition;
  const normalizedInput = await validateInput(inputSchema, input, taskId);

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
    taskId,
    (key, value, durationMs) => {
      const source = sourceMap[key]!;
      const type = isInputSource(source) ? "input" : isChunks(value) ? "chunks" : "value";

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
  const derived: TDerived = deriveFn ? deriveFn({ context: resolvedForDerive }) : ({} as TDerived);

  // --- apply policies ---
  const budget = policies.budget ?? Infinity;
  const { allowed, records: policyRecords } = applyPolicies<
    InferSources<TInput, TSourceMap>,
    TDerived,
    TRequired,
    TPrefer
  >(resolvedRaw, derived, policies, taskId);

  // Excluded chunk sources are resolved before policies run. Attach redacted
  // chunk records so source-level trace entries remain self-contained and
  // clearly indicate policy exclusion.
  const excludedChunkKeys = new Set(
    policyRecords.filter((record) => record.action === "excluded").map((record) => record.source),
  );

  for (const key of excludedChunkKeys) {
    const raw = resolvedRaw.get(key);
    if (!isChunks(raw)) {
      continue;
    }

    const timing = sourceTimings.find((t) => t.key === key);
    if (timing && timing.chunkRecords === undefined) {
      timing.chunkRecords = raw.items.map((chunk) => ({
        content: "",
        score: chunk.score,
        included: false,
        reason: "excluded",
      }));
    }
  }

  const requiredKeys = new Set((policies.require ?? []).map(String));
  const preferredKeys = new Set((policies.prefer ?? []).map(String));
  const declaredChunkSourceKeys = new Set(
    Object.entries(sourceMap)
      .filter(([, source]) => isResolverSource(source) && source._sourceKind === "chunks")
      .map(([key]) => key),
  );

  if (templateFn) {
    // --- template path: render-measure-fit ---
    const resolution = resolveWithTemplate({
      resolvedRaw,
      derived,
      allowed,
      policyRecords,
      requiredKeys,
      preferredKeys,
      sourceTimings,
      budget,
      declaredChunkSourceKeys,
      templateFn: templateFn as (args: { context: Record<string, unknown> }) => PromptOutput,
      taskId,
    });

    const rawContextTokens = computeRawContextTokens(resolvedRaw);
    const includedContextTokens = computeIncludedContextTokens(resolution.context);
    const systemTokens = estimateTokens(resolution.prompt.system);
    const promptTokens = estimateTokens(resolution.prompt.prompt);
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
      taskId,
      startedAt,
      completedAt,
      sourceTimings: resolution.sourceTimings,
      policyRecords: resolution.policyRecords,
      derived,
      budgetMax: budget === Infinity ? 0 : budget,
      budgetUsed: totalTokens,
      promptTrace,
    });

    return {
      context: resolution.context as AllowedContext<
        InferSources<TInput, TSourceMap>,
        TDerived,
        TRequired
      >,
      prompt: resolution.prompt,
      trace,
    };
  }

  // --- non-template path: per-source TOON estimation (existing behavior) ---
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

    if (isChunks(raw)) {
      const packed = requiredKeys.has(key)
        ? packChunks(raw, Infinity)
        : packChunks(raw, budget === Infinity ? Infinity : budget - budgetUsed);

      // Attach chunk records to the source timing entry
      const timing = sourceTimings.find((t) => t.key === key);
      if (timing) timing.chunkRecords = packed.records;

      if (!requiredKeys.has(key) && raw.items.length > 0 && packed.included.length === 0) {
        policyRecords.push({ source: key, action: "dropped", reason: "over_budget" });
        continue;
      }

      budgetUsed += packed.tokensUsed;
      context[key] = packed.included;
    } else {
      if (declaredChunkSourceKeys.has(key) && isChunkEnvelope(raw)) {
        throw new TypeError(
          `Source "${key}" resolved malformed chunks. Expected Chunk[] items with string content.`,
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
    taskId,
    startedAt,
    completedAt,
    sourceTimings,
    policyRecords,
    derived,
    budgetMax: budget === Infinity ? 0 : budget,
    budgetUsed,
  });

  return {
    context: context as AllowedContext<InferSources<TInput, TSourceMap>, TDerived, TRequired>,
    trace,
  };
}

interface TemplateResolutionResult {
  context: Record<string, unknown>;
  prompt: PromptOutput;
  policyRecords: PolicyRecord[];
  sourceTimings: SourceTiming[];
}

/**
 * Render the template with the current context, then iteratively drop the lowest-priority
 * non-required sources and re-render until the output fits the budget.
 *
 * Drop order (ascending priority = first to drop):
 *   1. default-included sources (not in require or prefer)
 *   2. preferred sources
 *   Required sources are never dropped.
 *
 * After exhausting whole-source drops, trim the lowest-score chunks from chunk sources
 * one at a time until the prompt fits.
 */
function resolveWithTemplate(options: {
  resolvedRaw: Map<string, unknown>;
  derived: Record<string, unknown>;
  allowed: Set<string>;
  policyRecords: PolicyRecord[];
  requiredKeys: Set<string>;
  preferredKeys: Set<string>;
  sourceTimings: SourceTiming[];
  budget: number;
  declaredChunkSourceKeys: Set<string>;
  templateFn: (args: { context: Record<string, unknown> }) => PromptOutput;
  taskId: string;
}): TemplateResolutionResult {
  const {
    resolvedRaw,
    derived,
    allowed,
    policyRecords,
    requiredKeys,
    preferredKeys,
    sourceTimings,
    budget,
    declaredChunkSourceKeys,
    templateFn,
  } = options;

  // Build mutable context with all non-excluded sources (chunks included in full)
  const context: Record<string, unknown> = {};
  // Track chunk arrays separately so we can trim them
  const chunkContextKeys = new Set<string>();

  for (const key of allowed) {
    const raw = resolvedRaw.get(key);
    if (isChunks(raw)) {
      // Start with all chunks; trimming happens in the fitting loop
      context[key] = [...raw.items];
      chunkContextKeys.add(key);
      // Attach full chunk records to timing
      const timing = sourceTimings.find((t) => t.key === key);
      if (timing) {
        timing.chunkRecords = raw.items.map((c) => ({
          content: c.content,
          score: c.score,
          included: true,
        }));
      }
    } else {
      if (declaredChunkSourceKeys.has(key) && isChunkEnvelope(raw)) {
        throw new TypeError(
          `Source "${key}" resolved malformed chunks. Expected Chunk[] items with string content.`,
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
    const prompt = renderTemplate(templateFn, context);
    return { context, prompt, policyRecords, sourceTimings };
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

  const renderTokens = (p: PromptOutput) => estimateTokens(p.system) + estimateTokens(p.prompt);

  let prompt = renderTemplate(templateFn, context);

  // Phase 1: drop whole non-chunk sources (default-included before preferred)
  while (renderTokens(prompt) > budget && droppableNonChunk.length > 0) {
    const keyToDrop = droppableNonChunk.shift()!;
    policyRecords.push({ source: keyToDrop, action: "dropped", reason: "over_budget" });
    delete context[keyToDrop];
    prompt = renderTemplate(templateFn, context);
  }

  // Phase 2: trim chunks one-at-a-time from chunk sources (lowest score first)
  if (renderTokens(prompt) > budget) {
    let trimmed = true;
    while (renderTokens(prompt) > budget && trimmed) {
      trimmed = false;

      // Find a non-required chunk source still in context that has more than one chunk
      for (const key of chunkContextKeys) {
        if (requiredKeys.has(key)) continue;
        if (!(key in context)) continue;
        const chunks = context[key] as Array<{ content: string; score?: number }>;
        if (chunks.length <= 1) continue;

        // Drop the lowest-score chunk
        const lowestIdx = chunks.reduce(
          (minIdx, c, i) => ((c.score ?? 0) < (chunks[minIdx]?.score ?? 0) ? i : minIdx),
          0,
        );
        chunks.splice(lowestIdx, 1);

        // Update chunk records in timing
        const timing = sourceTimings.find((t) => t.key === key);
        if (timing?.chunkRecords) {
          const record = timing.chunkRecords.filter((record) => record.included)[lowestIdx];
          if (record) {
            record.included = false;
            record.reason = "chunk_trimmed_over_budget";
          }
        }

        prompt = renderTemplate(templateFn, context);
        trimmed = true;
        break;
      }
    }
  }

  // Phase 3: drop whole chunk sources if still over budget (last resort)
  while (renderTokens(prompt) > budget && droppableChunkWhole.length > 0) {
    const keyToDrop = droppableChunkWhole.shift()!;
    policyRecords.push({
      source: keyToDrop,
      action: "dropped",
      reason: "over_budget",
    });
    const timing = sourceTimings.find((t) => t.key === keyToDrop);
    if (timing?.chunkRecords) {
      for (const record of timing.chunkRecords) {
        record.included = false;
        record.reason = "source_dropped_over_budget";
      }
    }
    delete context[keyToDrop];
    prompt = renderTemplate(templateFn, context);
  }

  return { context, prompt, policyRecords, sourceTimings };
}
