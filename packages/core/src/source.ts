import { createChunks } from "./chunks.ts";
import type {
  AnyInput,
  AnySchema,
  Chunk,
  ChunkSource,
  ChunkSourceConfig,
  DependentChunkSourceConfig,
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

export function createChunkSource<TSchema extends AnySchema, TItem>(
  inputSchema: TSchema,
  config: ChunkSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
): ChunkSource<InferSchemaOutputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "chunks",
    _dependencyRefs: [],
    _input: undefined,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput, context) {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      void context;
      const result = await config.resolve({ input: normalizedInput });

      if (config.normalize) {
        return createChunks(Promise.resolve(result as TItem[]), config.normalize);
      }

      return createChunks(Promise.resolve(result as Chunk[]));
    },
  };
}

export function createDependentChunkSource<
  TSchema extends AnySchema,
  TDeps extends Record<string, AnyResolverSource>,
  TItem,
>(
  inputSchema: TSchema,
  deps: TDeps,
  config: DependentChunkSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
): ChunkSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>> {
  const dependencyKeys = Object.keys(deps) as Array<Extract<keyof TDeps, string>>;

  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "chunks",
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
      const result = await config.resolve(args);

      if (config.normalize) {
        return createChunks(Promise.resolve(result as TItem[]), config.normalize);
      }

      return createChunks(Promise.resolve(result as Chunk[]));
    },
  };
}
