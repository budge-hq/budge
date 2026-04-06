import { createDefinition } from "./define.ts";
import { resolveDefinition } from "./resolve.ts";
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
  ResolverSource,
  SourceConfig,
  WindowHandle,
} from "./types.ts";

export interface ValueSourceFactory {
  <TSchema extends InputSchema<AnyInput, AnyInput>, TOutput>(
    input: TSchema,
    config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
  ): ResolverSource<
    Awaited<TOutput>,
    InferSchemaOutputObject<TSchema>,
    InferSchemaInputObject<TSchema>
  >;
}

export interface RagSourceFactory {
  <TSchema extends InputSchema<AnyInput, AnyInput>, TItem>(
    input: TSchema,
    config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
  ): RagSource<InferSchemaOutputObject<TSchema>, InferSchemaInputObject<TSchema>>;
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

function emitTrace(options: BudgeOptions, trace: { trace?: unknown } | undefined): void {
  if (!trace || !("trace" in trace) || trace.trace === undefined) {
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
      const definition = createDefinition(
        config.input as unknown as InputSchema<
          InferSchemaInputObject<TSchema>,
          InferSchemaOutputObject<TSchema>
        >,
        {
          id: config.id,
          maxTokens: config.maxTokens,
          compose: config.compose,
        },
      );

      return {
        id: config.id,
        async resolve(payload: { input: InferSchemaInputObject<TSchema> }) {
          try {
            const result = await resolveDefinition(definition, payload);
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
