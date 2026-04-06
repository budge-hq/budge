import { randomUUID } from "node:crypto";
import { BudgetExceededError, RequiredSourceValueError, SourceResolutionError } from "./errors.ts";
import { isRagItems } from "./rag.ts";
import { estimateTokens, serialize } from "./pack.ts";
import { buildTrace } from "./trace.ts";
import type { SourceTiming } from "./trace.ts";
import type {
  AnyInput,
  AnyResolverSource,
  ComposeContext,
  ComposeResult,
  Definition,
  InferSource,
  InferSourceInput,
  PromptTrace,
  RenderableValue,
  ResolveResult,
  UseFn,
} from "./types.ts";

interface RenderState {
  proxyCache: WeakMap<object, unknown>;
  slotCache: WeakMap<object, string>;
  slotValues: Map<string, unknown>;
  slotNonce: string;
  slotCounter: number;
}

function isRenderableObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function createSlotToken(state: RenderState, value: object): string {
  const existing = state.slotCache.get(value);
  if (existing) {
    return existing;
  }

  const token = `\u001fBUDGE_SLOT_${state.slotNonce}_${state.slotCounter++}\u001f`;
  state.slotCache.set(value, token);
  state.slotValues.set(token, value);
  return token;
}

function wrapRenderableValue<T>(value: T, state: RenderState): RenderableValue<T> {
  if (!isRenderableObject(value)) {
    return value as RenderableValue<T>;
  }

  const cached = state.proxyCache.get(value);
  if (cached !== undefined) {
    return cached as RenderableValue<T>;
  }

  const proxy = new Proxy(value, {
    get(target, prop, receiver) {
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
  });

  state.proxyCache.set(value, proxy);
  return proxy as RenderableValue<T>;
}

function materializeText(
  text: string | undefined,
  slotValues: Map<string, unknown>,
): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  let output = text;
  for (const [token, value] of slotValues) {
    output = output.split(token).join(serialize(value));
  }
  return output;
}

function normalizeComposeResult(result: ComposeResult): ComposeResult {
  if (result.system !== undefined && typeof result.system !== "string") {
    throw new TypeError("compose() must return a string or undefined for system.");
  }

  if (result.prompt !== undefined && typeof result.prompt !== "string") {
    throw new TypeError("compose() must return a string or undefined for prompt.");
  }

  return result;
}

async function validateInput<TResolveInput extends AnyInput, TInput extends AnyInput>(
  schema: Definition<TInput, TResolveInput>["_inputSchema"],
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

function unwrapSourceValue(value: unknown): unknown {
  return isRagItems(value) ? value.items : value;
}

function createPromptTrace(system: string | undefined, prompt: string | undefined): PromptTrace {
  const systemTokens = estimateTokens(system ?? "");
  const promptTokens = estimateTokens(prompt ?? "");

  return {
    systemTokens,
    promptTokens,
    totalTokens: systemTokens + promptTokens,
  };
}

function attachTrace(error: unknown, trace: ResolveResult["trace"]): void {
  if (typeof error === "object" && error !== null) {
    (error as { trace?: ResolveResult["trace"] }).trace = trace;
  }
}

function createUse(windowId: string, state: RenderState, sourceTimings: SourceTiming[]): UseFn {
  const use = async <TSource extends AnyResolverSource>(
    source: TSource,
    input: InferSourceInput<TSource>,
  ): Promise<NonNullable<RenderableValue<InferSource<TSource>>>> => {
    const startedAt = Date.now();

    try {
      const resolved = await source.resolve(input);
      const unwrapped = unwrapSourceValue(resolved);

      if (unwrapped === null || unwrapped === undefined) {
        throw new RequiredSourceValueError(source._internalId, windowId);
      }

      const resolvedAt = new Date();
      sourceTimings.push({
        sourceId: source._internalId,
        kind: source._sourceKind,
        tags: source.tags ?? [],
        resolvedAt,
        durationMs: Date.now() - startedAt,
        ...(Array.isArray(unwrapped) && source._sourceKind === "rag"
          ? { itemCount: unwrapped.length }
          : {}),
      });

      return wrapRenderableValue(unwrapped, state) as unknown as NonNullable<
        RenderableValue<InferSource<TSource>>
      >;
    } catch (error) {
      if (error instanceof RequiredSourceValueError) {
        throw error;
      }

      throw new SourceResolutionError(source._internalId, windowId, error);
    }
  };

  return use satisfies UseFn;
}

export async function resolveDefinition<
  TInput extends AnyInput,
  TResolveInput extends AnyInput = TInput,
>(
  definition: Definition<TInput, TResolveInput>,
  payload: { input: TResolveInput },
): Promise<ResolveResult> {
  const startedAt = new Date();
  const sourceTimings: SourceTiming[] = [];
  const renderState: RenderState = {
    proxyCache: new WeakMap(),
    slotCache: new WeakMap(),
    slotValues: new Map(),
    slotNonce: randomUUID(),
    slotCounter: 0,
  };

  const normalizedInput = await validateInput(
    definition._inputSchema,
    payload.input,
    definition._id,
  );
  const composeContext: ComposeContext<TInput> = {
    input: normalizedInput,
    use: createUse(definition._id, renderState, sourceTimings),
  };

  try {
    const composed = normalizeComposeResult(await definition._compose(composeContext));
    const system = materializeText(composed.system, renderState.slotValues);
    const prompt = materializeText(composed.prompt, renderState.slotValues);
    const promptTrace = createPromptTrace(system, prompt);
    const budgetExceeded =
      Number.isFinite(definition._maxTokens) && promptTrace.totalTokens > definition._maxTokens;
    const completedAt = new Date();
    const trace = buildTrace({
      windowId: definition._id,
      startedAt,
      completedAt,
      sourceTimings,
      budgetMax: definition._maxTokens,
      budgetUsed: promptTrace.totalTokens,
      budgetExceeded,
      prompt: promptTrace,
    });

    if (budgetExceeded) {
      const error = new BudgetExceededError(
        definition._id,
        definition._maxTokens,
        promptTrace.totalTokens,
      );
      error.trace = trace;
      throw error;
    }

    return { system, prompt, trace };
  } catch (error) {
    if (
      error instanceof BudgetExceededError ||
      error instanceof RequiredSourceValueError ||
      error instanceof SourceResolutionError
    ) {
      if (!error.trace) {
        const completedAt = new Date();
        const trace = buildTrace({
          windowId: definition._id,
          startedAt,
          completedAt,
          sourceTimings,
          budgetMax: definition._maxTokens,
          budgetUsed: 0,
          budgetExceeded: false,
          prompt: {
            systemTokens: 0,
            promptTokens: 0,
            totalTokens: 0,
          },
        });
        error.trace = trace;
      }

      throw error;
    }

    const completedAt = new Date();
    const trace = buildTrace({
      windowId: definition._id,
      startedAt,
      completedAt,
      sourceTimings,
      budgetMax: definition._maxTokens,
      budgetUsed: 0,
      budgetExceeded: false,
      prompt: {
        systemTokens: 0,
        promptTokens: 0,
        totalTokens: 0,
      },
    });

    attachTrace(error, trace);
    throw error;
  }
}
