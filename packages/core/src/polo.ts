import type {
  AnyInput,
  AnySchema,
  AnyResolverSource,
  ChunkSource,
  ChunkSourceConfig,
  DependentChunkSourceConfig,
  DependentSourceConfig,
  Definition,
  DefinitionConfig,
  DeriveFn,
  EnforceSourceDependencies,
  FromInputSourceOptions,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InferSources,
  InputSchema,
  InputSource,
  MergeSourceSets,
  Policies,
  PoloOptions,
  Resolution,
  ResolverSource,
  SourceSet,
  SourceSetBrand,
  SourceConfig,
  SourceShape,
  TemplateFn,
} from "./types.ts";
import { createDefinition } from "./define.ts";
import { buildWaves } from "./graph.ts";
import { resolveDefinition } from "./resolve.ts";
import {
  createChunkSource,
  createDependentChunkSource,
  createDependentValueSource,
  createFromInputSource,
  createValueSource,
} from "./source.ts";

interface SourceFactory {
  <TSchema extends AnySchema, TOutput>(
    input: TSchema,
    config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
  ): ResolverSource<Awaited<TOutput>, InferSchemaOutputObject<TSchema>>;

  <TSchema extends AnySchema, const TDeps extends Record<string, AnyResolverSource>, TOutput>(
    input: TSchema,
    deps: TDeps,
    config: DependentSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TOutput>,
  ): ResolverSource<
    Awaited<TOutput>,
    InferSchemaOutputObject<TSchema>,
    string,
    Extract<keyof TDeps, string>
  >;

  fromInput<TKey extends string>(key: TKey, options?: FromInputSourceOptions): InputSource<TKey>;

  chunks<TSchema extends AnySchema, TItem>(
    input: TSchema,
    config: ChunkSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
  ): ChunkSource<InferSchemaOutputObject<TSchema>>;

  chunks<TSchema extends AnySchema, const TDeps extends Record<string, AnyResolverSource>, TItem>(
    input: TSchema,
    deps: TDeps,
    config: DependentChunkSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
  ): ChunkSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>>;
}

interface SourceSetFactory {
  value: SourceFactory;
  chunks: SourceFactory["chunks"];
}

let nextSourceSetOwnerId = 0;

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
      sources: TSourceMap &
        SourceShape<InferSchemaOutputObject<TSchema>, NoInfer<TSourceMap>> &
        EnforceSourceDependencies<NoInfer<TSourceMap>>;
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
  sourceSet<const TSources extends Record<string, AnyResolverSource>>(
    builder: (sources: SourceSetFactory) => TSources,
  ): SourceSet<TSources>;
}

function createSourceFactory(): SourceFactory {
  return Object.assign(
    function source<
      TSchema extends AnySchema,
      const TDeps extends Record<string, AnyResolverSource>,
      TOutput,
    >(
      input: TSchema,
      depsOrConfig: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput> | TDeps,
      maybeConfig?: DependentSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TOutput>,
    ):
      | ResolverSource<Awaited<TOutput>, InferSchemaOutputObject<TSchema>>
      | ResolverSource<
          Awaited<TOutput>,
          InferSchemaOutputObject<TSchema>,
          string,
          Extract<keyof TDeps, string>
        > {
      if (maybeConfig) {
        return createDependentValueSource(input, depsOrConfig as TDeps, maybeConfig);
      }

      return createValueSource(
        input,
        depsOrConfig as SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
      );
    },
    {
      fromInput<TKey extends string>(
        key: TKey,
        options?: FromInputSourceOptions,
      ): InputSource<TKey> {
        return createFromInputSource(key, options);
      },
      chunks<
        TSchema extends AnySchema,
        const TDeps extends Record<string, AnyResolverSource>,
        TItem,
      >(
        input: TSchema,
        depsOrConfig: ChunkSourceConfig<InferSchemaOutputObject<TSchema>, TItem> | TDeps,
        maybeConfig?: DependentChunkSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
      ):
        | ChunkSource<InferSchemaOutputObject<TSchema>>
        | ChunkSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>> {
        if (maybeConfig) {
          return createDependentChunkSource(input, depsOrConfig as TDeps, maybeConfig);
        }

        return createChunkSource(
          input,
          depsOrConfig as ChunkSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
        );
      },
    },
  ) as SourceFactory;
}

function createSourceSetFactory(source: SourceFactory): SourceSetFactory {
  return {
    value: source,
    chunks: ((...args: Parameters<SourceFactory["chunks"]>) =>
      source.chunks(...args)) as unknown as SourceFactory["chunks"],
  };
}

function finalizeSourceSet<const TSources extends Record<string, AnyResolverSource>>(
  sources: TSources,
): SourceSet<TSources> {
  const seenSources = new Set<AnyResolverSource>();
  const ownerSetId = `set_${nextSourceSetOwnerId++}`;

  for (const [key, source] of Object.entries(sources)) {
    if (seenSources.has(source)) {
      throw new Error(`Source handle reused under multiple keys in sourceSet: "${key}".`);
    }

    if (source._ownerSetId && source._ownerSetId !== ownerSetId) {
      throw new Error(
        `Source handle for "${key}" is already owned by another sourceSet and cannot be reused.`,
      );
    }

    if (source._registeredId && source._registeredId !== key) {
      throw new Error(
        `Source handle reused under multiple source ids: "${source._registeredId}" and "${key}".`,
      );
    }

    seenSources.add(source);
    source._ownerSetId = ownerSetId;
    source._registeredId = key;
  }

  for (const [key, source] of Object.entries(sources)) {
    const dependencySources = source._dependencySources ?? {};
    const dependencyRefs = Object.entries(dependencySources).map(([alias, dependencySource]) => {
      const dependencyId = dependencySource._internalId;
      if (!dependencyId) {
        throw new Error(
          `Source "${key}" references an unregistered dependency. Dependencies must come from a sourceSet.`,
        );
      }

      if (dependencySource._registeredId && alias !== dependencySource._registeredId) {
        throw new Error(
          `Dependency aliases are not supported yet. Source "${key}" must reference dependency "${dependencySource._registeredId}" under its own key.`,
        );
      }

      return {
        alias,
        internalId: dependencyId,
        registeredId: dependencySource._registeredId,
      };
    });

    source._dependencyRefs = dependencyRefs;
  }

  return Object.defineProperties(sources, {
    _sourceSet: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    _sources: {
      configurable: false,
      enumerable: false,
      value: sources,
      writable: false,
    },
  }) as unknown as SourceSet<TSources>;
}

function isSourceSet(value: unknown): value is SourceSetBrand<Record<string, AnyResolverSource>> {
  return typeof value === "object" && value !== null && "_sourceSet" in value;
}

export function registerSources<const TSourceSets extends readonly SourceSet<any>[]>(
  ...sourceSets: TSourceSets
): MergeSourceSets<TSourceSets> {
  const merged: Record<string, AnyResolverSource> = {};

  for (const sourceSet of sourceSets) {
    if (!isSourceSet(sourceSet)) {
      throw new TypeError("registerSources() only accepts values created with polo.sourceSet().");
    }

    for (const [key, source] of Object.entries(sourceSet)) {
      if (key in merged) {
        throw new Error(`Duplicate source key "${key}" found while registering sources.`);
      }

      merged[key] = source;
    }
  }

  buildWaves(merged, "registered sources");
  return merged as MergeSourceSets<TSourceSets>;
}

export function createPolo(options: PoloOptions = {}): PoloInstance {
  const source = createSourceFactory();
  const sourceSetFactory = createSourceSetFactory(source);

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
        sources: TSourceMap &
          SourceShape<InferSchemaOutputObject<TSchema>, NoInfer<TSourceMap>> &
          EnforceSourceDependencies<NoInfer<TSourceMap>>;
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

    sourceSet(builder) {
      return finalizeSourceSet(builder(sourceSetFactory));
    },
  } satisfies PoloInstance;
}
