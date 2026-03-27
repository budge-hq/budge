// Public API
export { createPolo, registerSources } from "./polo.ts";
export type { PoloInstance } from "./polo.ts";

// Public types
export type {
  AnySchema,
  AnySource,
  AnyInput,
  Chunk,
  ChunkSource,
  ChunkRecord,
  Chunks,
  Definition,
  DeriveFn,
  ExcludeDecision,
  FromInputSourceOptions,
  InferContext,
  InferSchemaInput,
  InferSchemaInputObject,
  InferSchemaOutput,
  InferSchemaOutputObject,
  InferSource,
  InferSources,
  InputSchema,
  InputSource,
  Policies,
  PolicyExcludeFn,
  PoloLogger,
  PoloOptions,
  PolicyRecord,
  PromptOutput,
  PromptTrace,
  RenderableValue,
  ResolverSource,
  Resolution,
  SourceConfig,
  SourceResolveArgs,
  SourceTag,
  SourceShape,
  ChunkSourceConfig,
  SourceOptions,
  SourceRecord,
  SourceRecordType,
  TemplateFn,
  TemplateContext,
  Trace,
  ValueSource,
} from "./types.ts";

// Errors
export { RequiredSourceMissingError, SourceResolutionError } from "./errors.ts";
