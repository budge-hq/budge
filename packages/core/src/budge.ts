import { createWindowSpec } from "./window-spec.ts";
import { resolveWindowSpec } from "./resolve.ts";
import {
  createDependentRagSource,
  createDependentValueSource,
  createFromInputSource,
  createHistorySource,
  createRagSource,
  createToolsSource,
  createValueSource,
} from "./source.ts";
import type {
  AnyInput,
  AnyResolverSource,
  AnySource,
  BudgeOptions,
  DependentRagSourceConfig,
  DependentSourceConfig,
  FromInputSourceOptions,
  HistorySource,
  HistorySourceConfig,
  InferSources,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InputSource,
  InputSchema,
  ToolsSource,
  ToolsSourceConfig,
  RagSource,
  RagSourceConfig,
  SourceShape,
  SourceConfig,
  ValueSource,
  WindowHandle,
} from "./types.ts";

interface ValueSourceFactory {
  <TSchema extends InputSchema<AnyInput, AnyInput>, TOutput>(
    input: TSchema,
    config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
  ): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>>;

  <
    TSchema extends InputSchema<AnyInput, AnyInput>,
    const TDeps extends Record<string, AnyResolverSource>,
    TOutput,
  >(
    input: TSchema,
    deps: TDeps,
    config: DependentSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TOutput>,
  ): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>>;
}

interface RagSourceFactory {
  <TSchema extends InputSchema<AnyInput, AnyInput>, TItem>(
    input: TSchema,
    config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
  ): RagSource<InferSchemaInputObject<TSchema>>;

  <
    TSchema extends InputSchema<AnyInput, AnyInput>,
    const TDeps extends Record<string, AnyResolverSource>,
    TItem,
  >(
    input: TSchema,
    deps: TDeps,
    config: DependentRagSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
  ): RagSource<InferSchemaInputObject<TSchema>>;
}

export interface SourceFactory {
  value: ValueSourceFactory;
  rag: RagSourceFactory;
  fromInput<TKey extends string>(key: TKey, options?: FromInputSourceOptions): InputSource<TKey>;
  history<TSchema extends InputSchema<AnyInput, AnyInput>>(
    input: TSchema,
    config: HistorySourceConfig<InferSchemaOutputObject<TSchema>>,
  ): HistorySource<InferSchemaInputObject<TSchema>>;
  tools(config: ToolsSourceConfig): ToolsSource;
}

export interface BudgeInstance {
  window<
    TSchema extends InputSchema<AnyInput, AnyInput>,
    const TSourceMap extends Record<string, AnySource>,
  >(config: {
    id: string;
    input: TSchema;
    sources: (helpers: {
      source: SourceFactory;
    }) => TSourceMap & SourceShape<InferSchemaOutputObject<TSchema>, TSourceMap>;
  }): WindowHandle<
    InferSchemaInputObject<TSchema>,
    InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>
  >;

  source: SourceFactory;
}

function createSourceFactory(): SourceFactory {
  const value: ValueSourceFactory = (
    input: InputSchema<AnyInput, AnyInput>,
    depsOrConfig: SourceConfig<AnyInput, unknown> | Record<string, AnyResolverSource>,
    maybeConfig?: DependentSourceConfig<AnyInput, Record<string, AnyResolverSource>, unknown>,
  ) => {
    if (maybeConfig) {
      return createDependentValueSource(
        input,
        depsOrConfig as Record<string, AnyResolverSource>,
        maybeConfig,
      );
    }

    return createValueSource(input, depsOrConfig as SourceConfig<AnyInput, unknown>);
  };

  const rag: RagSourceFactory = (
    input: InputSchema<AnyInput, AnyInput>,
    depsOrConfig: RagSourceConfig<AnyInput, unknown> | Record<string, AnyResolverSource>,
    maybeConfig?: DependentRagSourceConfig<AnyInput, Record<string, AnyResolverSource>, unknown>,
  ) => {
    if (maybeConfig) {
      return createDependentRagSource(
        input,
        depsOrConfig as Record<string, AnyResolverSource>,
        maybeConfig,
      );
    }

    return createRagSource(input, depsOrConfig as RagSourceConfig<AnyInput, unknown>);
  };

  return {
    value,
    rag,
    fromInput(key, options) {
      return createFromInputSource(key, options);
    },
    history(input, config) {
      return createHistorySource(input, config);
    },
    tools(config) {
      return createToolsSource(config);
    },
  };
}

function emitTrace(options: BudgeOptions, result: unknown): void {
  if (
    typeof result !== "object" ||
    result === null ||
    !("traces" in result) ||
    result.traces === undefined
  ) {
    return;
  }

  try {
    options.onTrace?.(result.traces as Parameters<NonNullable<BudgeOptions["onTrace"]>>[0]);
  } catch {
    // Observer hooks must not affect resolution results.
  }

  try {
    options.logger?.info?.({ traces: result.traces });
  } catch {
    // Logging failures must not affect resolution results.
  }
}

export function createBudge(options: BudgeOptions = {}): BudgeInstance {
  const source = createSourceFactory();

  return {
    window<
      TSchema extends InputSchema<AnyInput, AnyInput>,
      const TSourceMap extends Record<string, AnySource>,
    >(config: {
      id: string;
      input: TSchema;
      sources: (helpers: {
        source: SourceFactory;
      }) => TSourceMap & SourceShape<InferSchemaOutputObject<TSchema>, TSourceMap>;
    }): WindowHandle<
      InferSchemaInputObject<TSchema>,
      InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>
    > {
      const sourceMap = config.sources({ source }) as TSourceMap;
      const windowSpec = createWindowSpec<TSchema, TSourceMap>(config.input, {
        id: config.id,
        sources: sourceMap,
      });

      return {
        id: config.id,
        async resolve(payload: { input: InferSchemaInputObject<TSchema> }) {
          try {
            const result = await resolveWindowSpec(windowSpec, payload);
            emitTrace(options, result);
            return result;
          } catch (error) {
            emitTrace(options, error as { traces?: unknown });
            throw error;
          }
        },
      };
    },
    source,
  };
}
