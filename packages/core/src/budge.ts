import { createWindowSpec } from "./window-spec.ts";
import { resolveWindowSpec } from "./resolve.ts";
import { createRagSource, createValueSource } from "./source.ts";
import type {
  AnyInput,
  BudgeOptions,
  ComposeContext,
  ComposeResult,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InputSchema,
  RagSource,
  RagSourceConfig,
  SourceConfig,
  ValueSource,
  WindowHandle,
} from "./types.ts";

interface ValueSourceFactory {
  <TSchema extends InputSchema<AnyInput, AnyInput>, TOutput>(
    input: TSchema,
    config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
  ): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>>;
}

interface RagSourceFactory {
  <TSchema extends InputSchema<AnyInput, AnyInput>, TItem>(
    input: TSchema,
    config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
  ): RagSource<InferSchemaInputObject<TSchema>>;
}

export interface SourceFactory {
  value: ValueSourceFactory;
  rag: RagSourceFactory;
}

export interface BudgeInstance {
  window<TSchema extends InputSchema<AnyInput, AnyInput>>(config: {
    id: string;
    input: TSchema;
    maxTokens: number;
    compose: (
      context: ComposeContext<InferSchemaOutputObject<TSchema>>,
    ) => ComposeResult | Promise<ComposeResult>;
  }): WindowHandle<InferSchemaInputObject<TSchema>>;

  source: SourceFactory;
}

function createSourceFactory(): SourceFactory {
  const value: ValueSourceFactory = (input, config) => {
    return createValueSource(input, config);
  };

  const rag: RagSourceFactory = (input, config) => {
    return createRagSource(input, config);
  };

  return { value, rag };
}

function emitTrace(options: BudgeOptions, trace: unknown): void {
  if (
    typeof trace !== "object" ||
    trace === null ||
    !("trace" in trace) ||
    trace.trace === undefined
  ) {
    return;
  }

  try {
    options.onTrace?.(trace.trace as Parameters<NonNullable<BudgeOptions["onTrace"]>>[0]);
  } catch {
    // Observer hooks must not affect resolution results.
  }

  try {
    options.logger?.info?.({ trace: trace.trace });
  } catch {
    // Logging failures must not affect resolution results.
  }
}

export function createBudge(options: BudgeOptions = {}): BudgeInstance {
  const source = createSourceFactory();

  return {
    window<TSchema extends InputSchema<AnyInput, AnyInput>>(config: {
      id: string;
      input: TSchema;
      maxTokens: number;
      compose: (
        context: ComposeContext<InferSchemaOutputObject<TSchema>>,
      ) => ComposeResult | Promise<ComposeResult>;
    }): WindowHandle<InferSchemaInputObject<TSchema>> {
      const windowSpec = createWindowSpec(config.input, {
        id: config.id,
        maxTokens: config.maxTokens,
        compose: config.compose,
      });

      return {
        id: config.id,
        async resolve(payload: { input: InferSchemaInputObject<TSchema> }) {
          try {
            const result = await resolveWindowSpec(windowSpec, payload);
            emitTrace(options, result);
            return result;
          } catch (error) {
            emitTrace(options, error as { trace?: unknown });
            throw error;
          }
        },
      };
    },
    source,
  };
}
