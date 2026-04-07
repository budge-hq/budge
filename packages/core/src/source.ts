import type {
  AnyInput,
  AnyResolverSource,
  AnySchema,
  Chunk,
  DependentRagSourceConfig,
  DependentSourceConfig,
  FromInputSourceOptions,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InputSource,
  InputSchema,
  RagSource,
  RagSourceConfig,
  SourceDepValues,
  SourceResolveArgs,
  SourceConfig,
  ValueSource,
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

function isChunkArray(values: unknown): values is Chunk[] {
  return Array.isArray(values) && values.every(isChunk);
}

async function validateSourceInput<TSchema extends InputSchema<AnyInput, AnyInput>>(
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
    const details = result.issues.map((issue: { message: string }) => issue.message).join("; ");
    throw new Error(`Source output validation failed: ${details}`);
  }

  return result.value as TOutput;
}

export function createFromInputSource<TKey extends string>(
  key: TKey,
  options?: FromInputSourceOptions,
): InputSource<TKey> {
  return {
    _type: "input",
    _internalId: createSourceInternalId(),
    _sourceKind: "input",
    _key: key,
    _tags: options?.tags ?? [],
  };
}

export function createValueSource<TSchema extends InputSchema<AnyInput, AnyInput>, TOutput>(
  inputSchema: TSchema,
  config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>> {
  return createDependentValueSource(inputSchema, {}, config);
}

export function createDependentValueSource<
  TSchema extends InputSchema<AnyInput, AnyInput>,
  const TDeps extends Record<string, AnyResolverSource>,
  TOutput,
>(
  inputSchema: TSchema,
  dependencies: TDeps,
  config: DependentSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TOutput>,
): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "value",
    _dependencySources: dependencies,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(
      runtimeInput: InferSchemaInputObject<TSchema>,
      context: Record<string, unknown> = {},
    ): Promise<Awaited<TOutput>> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolveArgs = {
        input: normalizedInput,
        ...context,
      } as unknown as SourceResolveArgs<InferSchemaOutputObject<TSchema>> & SourceDepValues<TDeps>;
      const resolved = await config.resolve(resolveArgs);
      return await validateSourceOutput(config.output, resolved as Awaited<TOutput>);
    },
  };
}

export function createRagSource<TSchema extends InputSchema<AnyInput, AnyInput>, TItem>(
  inputSchema: TSchema,
  config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
): RagSource<InferSchemaInputObject<TSchema>> {
  return createDependentRagSource(inputSchema, {}, config);
}

export function createDependentRagSource<
  TSchema extends InputSchema<AnyInput, AnyInput>,
  const TDeps extends Record<string, AnyResolverSource>,
  TItem,
>(
  inputSchema: TSchema,
  dependencies: TDeps,
  config: DependentRagSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
): RagSource<InferSchemaInputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "rag",
    _dependencySources: dependencies,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(
      runtimeInput: InferSchemaInputObject<TSchema>,
      context: Record<string, unknown> = {},
    ): Promise<Chunk[]> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolveArgs = {
        input: normalizedInput,
        ...context,
      } as unknown as SourceResolveArgs<InferSchemaOutputObject<TSchema>> & SourceDepValues<TDeps>;
      const result = await config.resolve(resolveArgs);
      const validated = await validateSourceOutput(config.output, result);

      if (!Array.isArray(validated)) {
        throw new TypeError("budge.source.rag() resolve() must return an array.");
      }

      if (config.normalize) {
        const normalizedItems = validated.map((item) => config.normalize!(item as TItem));

        if (!isChunkArray(normalizedItems)) {
          throw new TypeError(
            "budge.source.rag() normalize() must return Chunk objects with string content.",
          );
        }

        return normalizedItems;
      }

      if (!isChunkArray(validated)) {
        throw new TypeError(
          "budge.source.rag() requires either Chunk[] input or a normalize function.",
        );
      }

      return validated;
    },
  };
}
