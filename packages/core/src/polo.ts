import type {
  AnyInput,
  AnySchema,
  AnyResolverSource,
  ChunkSource,
  ChunkSourceConfig,
  Definition,
  DefinitionConfig,
  DeriveFn,
  FromInputSourceOptions,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InferSources,
  InputSchema,
  InputSource,
  Policies,
  PoloOptions,
  Resolution,
  ResolverSource,
  SourceConfig,
  SourceShape,
  TemplateFn,
} from "./types.ts";
import { createDefinition } from "./define.ts";
import { resolveDefinition } from "./resolve.ts";
import { createChunkSource, createFromInputSource, createValueSource } from "./source.ts";

interface SourceFactory {
  <TSchema extends AnySchema, TContext extends Record<string, unknown>, TOutput>(
    input: TSchema,
    config: SourceConfig<InferSchemaOutputObject<TSchema>, TContext, TOutput>,
  ): ResolverSource<Awaited<TOutput>, InferSchemaOutputObject<TSchema>>;

  fromInput<TKey extends string>(key: TKey, options?: FromInputSourceOptions): InputSource<TKey>;

  chunks<TSchema extends AnySchema, TContext extends Record<string, unknown>, TItem>(
    input: TSchema,
    config: ChunkSourceConfig<InferSchemaOutputObject<TSchema>, TContext, TItem>,
  ): ChunkSource<InferSchemaOutputObject<TSchema>>;
}

export interface PoloInstance {
  /**
   * Declare the context contract for a task.
   */
  define<
    TSchema extends AnySchema,
    const TSourceMap extends Record<string, unknown>,
    TDerived extends Record<string, unknown> = Record<string, never>,
    const TRequired extends readonly Extract<
      keyof InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
      string
    >[] = [],
    const TPrefer extends readonly Extract<
      keyof InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
      string
    >[] = [],
  >(
    input: TSchema,
    config: {
      id: string;
      sources: TSourceMap & SourceShape<InferSchemaOutputObject<TSchema>, NoInfer<TSourceMap>>;
      derive?: DeriveFn<InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>, TDerived>;
      policies?: Policies<
        InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        NoInfer<TDerived>,
        TRequired,
        TPrefer
      >;
      template?: TemplateFn<
        InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        NoInfer<TDerived>,
        TRequired
      >;
    },
  ): Definition<
    InferSchemaOutputObject<TSchema>,
    TSourceMap,
    TDerived,
    TRequired,
    TPrefer,
    InferSchemaInputObject<TSchema>
  >;

  /**
   * Resolve context at runtime for a task definition.
   */
  resolve<
    TInput extends AnyInput,
    TSourceMap extends Record<string, unknown>,
    TDerived extends Record<string, unknown>,
    TRequired extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
    TPrefer extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
    TResolveInput extends AnyInput = TInput,
  >(
    definition: Definition<TInput, TSourceMap, TDerived, TRequired, TPrefer, TResolveInput>,
    input: TResolveInput,
  ): Promise<Resolution<InferSources<TInput, TSourceMap>, TDerived, TRequired>>;

  source: SourceFactory;
}

function createSourceFactory(): SourceFactory {
  return Object.assign(
    function source<TSchema extends AnySchema, TContext extends Record<string, unknown>, TOutput>(
      input: TSchema,
      config: SourceConfig<InferSchemaOutputObject<TSchema>, TContext, TOutput>,
    ): ResolverSource<Awaited<TOutput>, InferSchemaOutputObject<TSchema>> {
      return createValueSource(input, config);
    },
    {
      fromInput<TKey extends string>(
        key: TKey,
        options?: FromInputSourceOptions,
      ): InputSource<TKey> {
        return createFromInputSource(key, options);
      },
      chunks<TSchema extends AnySchema, TContext extends Record<string, unknown>, TItem>(
        input: TSchema,
        config: ChunkSourceConfig<InferSchemaOutputObject<TSchema>, TContext, TItem>,
      ): ChunkSource<InferSchemaOutputObject<TSchema>> {
        return createChunkSource(input, config);
      },
    },
  );
}

export function registerSources<const TSourceRegistry extends Record<string, AnyResolverSource>>(
  sources: TSourceRegistry,
): TSourceRegistry {
  return sources;
}

export function createPolo(options: PoloOptions = {}): PoloInstance {
  const source = createSourceFactory();

  return {
    define<
      TSchema extends AnySchema,
      const TSourceMap extends Record<string, unknown>,
      TDerived extends Record<string, unknown> = Record<string, never>,
      const TRequired extends readonly Extract<
        keyof InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        string
      >[] = [],
      const TPrefer extends readonly Extract<
        keyof InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        string
      >[] = [],
    >(
      input: TSchema,
      config: {
        id: string;
        sources: TSourceMap & SourceShape<InferSchemaOutputObject<TSchema>, NoInfer<TSourceMap>>;
        derive?: DeriveFn<InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>, TDerived>;
        policies?: Policies<
          InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
          NoInfer<TDerived>,
          TRequired,
          TPrefer
        >;
        template?: TemplateFn<
          InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
          NoInfer<TDerived>,
          TRequired
        >;
      },
    ) {
      return createDefinition<
        InferSchemaOutputObject<TSchema>,
        TSourceMap,
        TDerived,
        TRequired,
        TPrefer,
        InferSchemaInputObject<TSchema>
      >(
        input as InputSchema<InferSchemaInputObject<TSchema>, InferSchemaOutputObject<TSchema>>,
        config as DefinitionConfig<
          InferSchemaOutputObject<TSchema>,
          TSourceMap,
          TDerived,
          TRequired,
          TPrefer
        >,
      );
    },

    async resolve(definition, input) {
      const resolution = await resolveDefinition(definition, input);
      options.onTrace?.(resolution.trace);
      options.logger?.info?.({ trace: resolution.trace });
      return resolution;
    },

    source,
  } satisfies PoloInstance;
}
