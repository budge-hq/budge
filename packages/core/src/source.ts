import { createRagItems } from "./rag.ts";
import type {
  AnyInput,
  AnySchema,
  Chunk,
  RagSource,
  RagSourceConfig,
  DependentRagSourceConfig,
  DependentSourceConfig,
  InputOptions,
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

async function validateSourceOutput<TOutput>(
  schema: AnySchema | undefined,
  value: TOutput,
): Promise<TOutput> {
  if (!schema) {
    return value;
  }

  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Source output validation failed: ${details}`);
  }

  return value;
}

export function createInputSource<TKey extends string>(
  key: TKey,
  options?: InputOptions,
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
      const resolved = await config.resolve({ input: normalizedInput });
      return await validateSourceOutput(config.output, resolved as Awaited<TOutput>);
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
  Extract<keyof TDeps, string>,
  TDeps
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

      const resolved = await config.resolve(args);
      return await validateSourceOutput(config.output, resolved as Awaited<TOutput>);
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
      const result = await config.resolve({ input: normalizedInput });

      const validated = await validateSourceOutput(config.output, result);

      if (config.normalize) {
        return createRagItems(Promise.resolve(validated as TItem[]), config.normalize);
      }

      return createRagItems(Promise.resolve(validated as Chunk[]));
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
): RagSource<InferSchemaOutputObject<TSchema>, string, Extract<keyof TDeps, string>, TDeps> {
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
      const result = await config.resolve(args);

      const validated = await validateSourceOutput(config.output, result);

      if (config.normalize) {
        return createRagItems(Promise.resolve(validated as TItem[]), config.normalize);
      }

      return createRagItems(Promise.resolve(validated as Chunk[]));
    },
  };
}
