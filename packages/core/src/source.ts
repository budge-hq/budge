import { createRagItems } from "./rag.ts";
import type {
  AnyInput,
  AnySchema,
  Chunk,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InputSchema,
  RagSource,
  RagSourceConfig,
  ResolverSource,
  SourceConfig,
} from "./types.ts";

let nextSourceInternalId = 0;

function createSourceInternalId(): string {
  return `src_${nextSourceInternalId++}`;
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

  return value;
}

export function createValueSource<TSchema extends InputSchema<AnyInput, AnyInput>, TOutput>(
  inputSchema: TSchema,
  config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
): ResolverSource<
  Awaited<TOutput>,
  InferSchemaOutputObject<TSchema>,
  InferSchemaInputObject<TSchema>
> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "value",
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput): Promise<Awaited<TOutput>> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolved = await config.resolve({ input: normalizedInput });
      return await validateSourceOutput(config.output, resolved as Awaited<TOutput>);
    },
  };
}

export function createRagSource<TSchema extends InputSchema<AnyInput, AnyInput>, TItem>(
  inputSchema: TSchema,
  config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
): RagSource<InferSchemaOutputObject<TSchema>, InferSchemaInputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "rag",
    output: config.output,
    tags: config.tags ?? [],
    async resolve(runtimeInput) {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const result = await config.resolve({ input: normalizedInput });
      const validated = await validateSourceOutput(config.output, result);

      if (config.normalize) {
        return createRagItems(Promise.resolve(validated as TItem[]), config.normalize);
      }

      return createRagItems(Promise.resolve(validated as Chunk[]));
    },
  };
}
