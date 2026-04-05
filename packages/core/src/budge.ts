import type {
  AnyInput,
  AnySchema,
  AnySource,
  AnyResolverSource,
  RagSource,
  RagSourceConfig,
  DependentRagSourceConfig,
  DependentSourceConfig,
  DefinitionConfig,
  DeriveFn,
  EnforceDerivedKeys,
  EnforceReservedContextKeys,
  EnforceSourceDependencies,
  EnforceUniqueSourceSetKeys,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InferSources,
  InputOptions,
  InputSchema,
  InputSource,
  MergeSourceSets,
  Policies,
  BudgeOptions,
  Resolution,
  RenderValue,
  ResolverSource,
  SourceSet,
  SourceSetBrand,
  SourceConfig,
  SourceShape,
} from "./types.ts";
import { BudgeSourceSetBrand } from "./types.ts";
import { createDefinition } from "./define.ts";
import { buildWaves } from "./graph.ts";
import { resolveDefinition } from "./resolve.ts";
import {
  createDependentRagSource,
  createRagSource,
  createDependentValueSource,
  createInputSource,
  createValueSource,
} from "./source.ts";

export interface ValueSourceFactory {
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
    Extract<keyof TDeps, string>,
    TDeps
  >;
}

export interface RagSourceFactory {
  rag<TSchema extends AnySchema, TItem>(
    input: TSchema,
    config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
  ): RagSource<InferSchemaOutputObject<TSchema>>;

  rag<TSchema extends AnySchema, const TDeps extends Record<string, AnyResolverSource>, TItem>(
    input: TSchema,
    deps: TDeps,
    config: DependentRagSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
  ): RagSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>, TDeps>;
}

export interface SourceFactory {
  value: ValueSourceFactory;
  rag: RagSourceFactory["rag"];
}

let nextSourceSetOwnerId = 0;

function validateWindowId(id: unknown): string {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("budge.window() requires a non-empty string id.");
  }

  return id;
}

function validateReservedWindowSourceKeys(sources: Record<string, AnySource>): void {
  if ("raw" in sources) {
    throw new TypeError('budge.window() reserves "raw" as a context key.');
  }
}

export interface BudgeInstance {
  /**
   * Declare a context window and return an async function: call it each turn with input.
   */
  window<
    TSchema extends AnySchema,
    const TSourceMap extends Record<string, AnySource> = Record<string, AnySource>,
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
    config: {
      /** Stable logical id for this context window; used to group traces across runs. */
      id: string;
      input: TSchema;
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
      system?: RenderValue<
        InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        NoInfer<TDerived>,
        TRequired
      >;
      prompt?: RenderValue<
        InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        NoInfer<TDerived>,
        TRequired
      >;
    } & EnforceDerivedKeys<InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>, TDerived> &
      EnforceReservedContextKeys<
        InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
        TDerived
      >,
  ): (
    input: InferSchemaInputObject<TSchema>,
  ) => Promise<
    Resolution<InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>, TDerived, TRequired>
  >;

  input<TKey extends string>(key: TKey, options?: InputOptions): InputSource<TKey>;

  source: SourceFactory;

  sourceSet<TSources extends Record<string, AnyResolverSource>>(
    builder: (factories: { source: SourceFactory }) => TSources,
  ): SourceSet<TSources>;

  sources<const TSourceSets extends readonly SourceSet<any>[]>(
    ...sourceSets: TSourceSets & EnforceUniqueSourceSetKeys<TSourceSets>
  ): MergeSourceSets<TSourceSets>;
}

function createSourceFactory(): SourceFactory {
  const value = function value<
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
        Extract<keyof TDeps, string>,
        TDeps
      > {
    if (maybeConfig) {
      return createDependentValueSource(input, depsOrConfig as TDeps, maybeConfig);
    }

    return createValueSource(
      input,
      depsOrConfig as SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
    );
  } as unknown as ValueSourceFactory;

  const rag = function rag<
    TSchema extends AnySchema,
    const TDeps extends Record<string, AnyResolverSource>,
    TItem,
  >(
    input: TSchema,
    depsOrConfig: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem> | TDeps,
    maybeConfig?: DependentRagSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
  ):
    | RagSource<InferSchemaOutputObject<TSchema>>
    | RagSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>, TDeps> {
    if (maybeConfig) {
      return createDependentRagSource(input, depsOrConfig as TDeps, maybeConfig);
    }

    return createRagSource(
      input,
      depsOrConfig as RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
    );
  } as RagSourceFactory["rag"];

  return { value, rag };
}

function finalizeSourceSet<TSources extends Record<string, AnyResolverSource>>(
  sources: TSources,
): SourceSet<TSources> {
  const seenSources = new Set<AnyResolverSource>();
  const ownerSetId = `set_${nextSourceSetOwnerId++}`;

  for (const [key, source] of Object.entries(sources)) {
    if (source._type !== "resolver") {
      throw new TypeError(
        `budge.sourceSet() only accepts resolver or rag sources. Use budge.input() for "${key}".`,
      );
    }

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

      return {
        alias,
        internalId: dependencyId,
        registeredId: dependencySource._registeredId,
      };
    });

    source._dependencyRefs = dependencyRefs;
  }

  return Object.defineProperties(sources, {
    [BudgeSourceSetBrand]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
  }) as unknown as SourceSet<TSources>;
}

function isSourceSet(value: unknown): value is SourceSetBrand<Record<string, AnyResolverSource>> {
  return typeof value === "object" && value !== null && BudgeSourceSetBrand in value;
}

function composeSources<const TSourceSets extends readonly SourceSet<any>[]>(
  ...sourceSets: TSourceSets & EnforceUniqueSourceSetKeys<TSourceSets>
): MergeSourceSets<TSourceSets> {
  const merged: Record<string, AnyResolverSource> = {};

  for (const sourceSet of sourceSets) {
    if (!isSourceSet(sourceSet)) {
      throw new TypeError("budge.sources() only accepts values created with budge.sourceSet().");
    }

    for (const [key, source] of Object.entries(sourceSet)) {
      if (key in merged) {
        throw new Error(`Duplicate source key "${key}" found while registering sources.`);
      }

      merged[key] = source as unknown as AnyResolverSource;
    }
  }

  buildWaves(merged, "composed sources");
  return merged as MergeSourceSets<TSourceSets>;
}

export function createBudge(options: BudgeOptions = {}): BudgeInstance {
  const source = createSourceFactory();

  return {
    window<
      TSchema extends AnySchema,
      const TSourceMap extends Record<string, AnySource> = Record<string, AnySource>,
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
      config: {
        id: string;
        input: TSchema;
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
        system?: RenderValue<
          InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
          NoInfer<TDerived>,
          TRequired
        >;
        prompt?: RenderValue<
          InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
          NoInfer<TDerived>,
          TRequired
        >;
      } & EnforceDerivedKeys<InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>, TDerived> &
        EnforceReservedContextKeys<
          InferSources<InferSchemaOutputObject<TSchema>, TSourceMap>,
          TDerived
        >,
    ) {
      const id = validateWindowId(config.id);
      validateReservedWindowSourceKeys(config.sources);

      const definition = createDefinition<
        InferSchemaOutputObject<TSchema>,
        TSourceMap,
        TDerived,
        TRequired,
        TPrefer,
        InferSchemaInputObject<TSchema>
      >(
        config.input as InputSchema<
          InferSchemaInputObject<TSchema>,
          InferSchemaOutputObject<TSchema>
        >,
        {
          id,
          sources: config.sources,
          derive: config.derive,
          policies: config.policies,
          system: config.system,
          prompt: config.prompt,
        } as DefinitionConfig<
          InferSchemaOutputObject<TSchema>,
          TSourceMap,
          TDerived,
          TRequired,
          TPrefer
        >,
      );

      return async (input: InferSchemaInputObject<TSchema>) => {
        const resolution = await resolveDefinition(definition, input as AnyInput);
        options.onTrace?.(resolution.trace);
        options.logger?.info?.({ trace: resolution.trace });
        return resolution;
      };
    },

    input(key, options) {
      return createInputSource(key, options);
    },

    source,

    sourceSet(builder) {
      return finalizeSourceSet(builder({ source }));
    },

    sources<const TSourceSets extends readonly SourceSet<any>[]>(
      ...sourceSets: TSourceSets & EnforceUniqueSourceSetKeys<TSourceSets>
    ) {
      return composeSources(...sourceSets) as MergeSourceSets<TSourceSets>;
    },
  } satisfies BudgeInstance;
}
