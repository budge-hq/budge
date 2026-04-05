import { createRagItems } from "./rag.ts";
import type {
  AnyInput,
  AnySchema,
  Chunk,
  RagItems,
  RagProfile,
  RagStageRecord,
  RagSource,
  RagSourceConfig,
  DependentRagSourceConfig,
  DependentSourceConfig,
  FromInputSourceOptions,
  InferSchemaOutputObject,
  InputSource,
  AnyResolverSource,
  ResolverSource,
  SourceDepValues,
  SourceConfig,
  SourceResolveArgs,
} from "./types.ts";

let nextSourceInternalId = 0;

function createSourceInternalId(): string {
  return `src_${nextSourceInternalId++}`;
}

function isChunk(value: unknown): value is Chunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string"
  );
}

function assertChunkArray(items: unknown, stageName: "rerank" | "compress"): Chunk[] {
  if (!Array.isArray(items) || !items.every(isChunk)) {
    throw new TypeError(
      `polo.source.rag() ${stageName}() must return Chunk[] with string content fields.`,
    );
  }

  return items;
}

function defaultRerank(profile: RagProfile | undefined, items: Chunk[]): Chunk[] {
  if (profile === "fast") {
    return items;
  }

  return [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function defaultCompress(profile: RagProfile | undefined, items: Chunk[]): Chunk[] {
  if (profile !== "high_precision") {
    return items;
  }

  const seen = new Set<string>();
  const deduped: Chunk[] = [];
  for (const item of items) {
    const key = `${item.content}\u0000${item.score ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

async function runRagPipeline<TArgs extends Record<string, unknown>, TItem>(
  args: TArgs,
  config: {
    profile?: RagProfile;
    normalize?: (item: TItem) => Chunk;
    resolve?: (args: TArgs) => Promise<TItem[] | Chunk[]> | TItem[] | Chunk[];
    retrieve?: (args: TArgs) => Promise<TItem[] | Chunk[]> | TItem[] | Chunk[];
    rerank?: (args: TArgs & { items: Chunk[] }) => Promise<Chunk[]> | Chunk[];
    compress?: (args: TArgs & { items: Chunk[] }) => Promise<Chunk[]> | Chunk[];
  },
): Promise<RagItems> {
  const profile = config.profile;

  const retrieveFn = config.retrieve ?? config.resolve;
  if (!retrieveFn) {
    throw new TypeError(
      "polo.source.rag() requires either resolve() or retrieve() in the source config.",
    );
  }

  const pipeline: RagStageRecord[] = [];

  const retrieveStartedAt = Date.now();
  const retrieved = await retrieveFn(args);
  let normalized = config.normalize
    ? await createRagItems(Promise.resolve(retrieved as TItem[]), config.normalize)
    : await createRagItems(Promise.resolve(retrieved as Chunk[]));
  pipeline.push({
    stage: "retrieve",
    inputItems: 0,
    outputItems: normalized.items.length,
    durationMs: Date.now() - retrieveStartedAt,
  });

  const rerankStartedAt = Date.now();
  const rerankedItems = config.rerank
    ? assertChunkArray(await config.rerank({ ...args, items: normalized.items }), "rerank")
    : defaultRerank(profile, normalized.items);
  pipeline.push({
    stage: "rerank",
    inputItems: normalized.items.length,
    outputItems: rerankedItems.length,
    durationMs: Date.now() - rerankStartedAt,
  });
  normalized = { ...normalized, items: rerankedItems };

  const compressStartedAt = Date.now();
  const compressedItems = config.compress
    ? assertChunkArray(await config.compress({ ...args, items: normalized.items }), "compress")
    : defaultCompress(profile, normalized.items);
  pipeline.push({
    stage: "compress",
    inputItems: normalized.items.length,
    outputItems: compressedItems.length,
    durationMs: Date.now() - compressStartedAt,
  });

  return {
    _type: "rag",
    items: compressedItems,
    ...(profile !== undefined && { _profile: profile }),
    _pipeline: pipeline,
  };
}

async function validateSourceInput<TSchema extends AnySchema>(
  schema: TSchema,
  input: AnyInput,
): Promise<InferSchemaOutputObject<TSchema>> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Source input validation failed: ${details}`);
  }

  return result.value as InferSchemaOutputObject<TSchema>;
}

export function createFromInputSource<TKey extends string>(
  key: TKey,
  options?: FromInputSourceOptions,
): InputSource<TKey> {
  return {
    _type: "input",
    _key: key,
    _tags: options?.tags ?? [],
  };
}

export function createValueSource<TSchema extends AnySchema, TOutput>(
  inputSchema: TSchema,
  config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
): ResolverSource<Awaited<TOutput>, InferSchemaOutputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "value",
    _dependencyRefs: [],
    _input: undefined,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput, context): Promise<Awaited<TOutput>> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      void context;
      return await config.resolve({ input: normalizedInput });
    },
  };
}

export function createDependentValueSource<
  TSchema extends AnySchema,
  TDeps extends Record<string, AnyResolverSource>,
  TOutput,
>(
  inputSchema: TSchema,
  deps: TDeps,
  config: DependentSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TOutput>,
): ResolverSource<
  Awaited<TOutput>,
  InferSchemaOutputObject<TSchema>,
  string,
  Extract<keyof TDeps, string>
> {
  const dependencyKeys = Object.keys(deps) as Array<Extract<keyof TDeps, string>>;

  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "value",
    _dependencyRefs: [],
    _dependencySources: deps,
    _input: undefined,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput, context): Promise<Awaited<TOutput>> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolvedDeps = Object.fromEntries(
        dependencyKeys.map((key) => [key, context[key]]),
      ) as Record<Extract<keyof TDeps, string>, unknown>;
      const args = {
        input: normalizedInput,
        ...(resolvedDeps as Record<string, unknown>),
      } as SourceResolveArgs<InferSchemaOutputObject<TSchema>> & SourceDepValues<TDeps>;

      return await config.resolve(args);
    },
  };
}

export function createRagSource<TSchema extends AnySchema, TItem>(
  inputSchema: TSchema,
  config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
): RagSource<InferSchemaOutputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "rag",
    _dependencyRefs: [],
    _input: undefined,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput, context) {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      void context;
      return runRagPipeline(
        { input: normalizedInput },
        {
          profile: config.profile,
          normalize: config.normalize,
          resolve: config.resolve,
          retrieve: config.retrieve,
          rerank: config.rerank,
          compress: config.compress,
        },
      );
    },
  };
}

export function createDependentRagSource<
  TSchema extends AnySchema,
  TDeps extends Record<string, AnyResolverSource>,
  TItem,
>(
  inputSchema: TSchema,
  deps: TDeps,
  config: DependentRagSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
): RagSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>> {
  const dependencyKeys = Object.keys(deps) as Array<Extract<keyof TDeps, string>>;

  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "rag",
    _dependencyRefs: [],
    _dependencySources: deps,
    _input: undefined,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput, context) {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolvedDeps = Object.fromEntries(
        dependencyKeys.map((key) => [key, context[key]]),
      ) as Record<Extract<keyof TDeps, string>, unknown>;
      const args = {
        input: normalizedInput,
        ...(resolvedDeps as Record<string, unknown>),
      } as SourceResolveArgs<InferSchemaOutputObject<TSchema>> & SourceDepValues<TDeps>;

      return runRagPipeline(args, {
        profile: config.profile,
        normalize: config.normalize,
        resolve: config.resolve,
        retrieve: config.retrieve,
        rerank: config.rerank,
        compress: config.compress,
      });
    },
  };
}
