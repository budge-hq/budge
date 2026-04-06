import type { StandardSchemaV1 } from "@standard-schema/spec";

export type AnyInput = Record<string, unknown>;

export type AnySchema = StandardSchemaV1;

export type InputSchema<
  TResolveInput extends AnyInput = AnyInput,
  TInput extends AnyInput = TResolveInput,
> = StandardSchemaV1<TResolveInput, TInput>;

export type InferSchemaInput<TSchema extends AnySchema> = StandardSchemaV1.InferInput<TSchema>;

export type InferSchemaOutput<TSchema extends AnySchema> = StandardSchemaV1.InferOutput<TSchema>;

export type InferSchemaInputObject<TSchema extends AnySchema> =
  InferSchemaInput<TSchema> extends AnyInput ? InferSchemaInput<TSchema> : never;

export type InferSchemaOutputObject<TSchema extends AnySchema> =
  InferSchemaOutput<TSchema> extends AnyInput ? InferSchemaOutput<TSchema> : never;

export type SourceTag = string;

export interface Chunk {
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RagItems {
  _type: "rag";
  items: Chunk[];
}

export interface SourceOptions {
  tags?: SourceTag[];
}

export interface SourceResolveArgs<TInput extends AnyInput> {
  input: TInput;
}

export interface SourceConfig<
  TInput extends AnyInput = AnyInput,
  TOutput = unknown,
> extends SourceOptions {
  output?: AnySchema;
  resolve(args: SourceResolveArgs<TInput>): Promise<TOutput> | TOutput;
}

export interface RagSourceConfig<
  TInput extends AnyInput = AnyInput,
  TItem = Chunk,
> extends SourceOptions {
  output?: AnySchema;
  normalize?: (item: TItem) => Chunk;
  resolve(args: SourceResolveArgs<TInput>): Promise<TItem[] | Chunk[]> | TItem[] | Chunk[];
}

export interface ResolverSource<
  TResult = unknown,
  TSourceInput extends AnyInput = AnyInput,
  TResolveInput extends AnyInput = TSourceInput,
> {
  _type: "resolver";
  _internalId: string;
  _sourceKind: "value" | "rag";
  output?: AnySchema;
  tags?: SourceTag[];
  resolve(input: AnyInput): Promise<TResult>;
  _input?: TSourceInput;
  _resolveInput?: TResolveInput;
}

export type ValueSource<
  TResult = unknown,
  TSourceInput extends AnyInput = AnyInput,
  TResolveInput extends AnyInput = TSourceInput,
> = ResolverSource<TResult, TSourceInput, TResolveInput>;

export type RagSource<
  TSourceInput extends AnyInput = AnyInput,
  TResolveInput extends AnyInput = TSourceInput,
> = ResolverSource<RagItems, TSourceInput, TResolveInput>;

export type AnyResolverSource = ResolverSource<unknown, AnyInput, AnyInput>;

type InferResolvedValue<TResult> = Awaited<TResult> extends RagItems ? Chunk[] : Awaited<TResult>;

export type InferSource<TSource> =
  TSource extends ResolverSource<infer TResult, AnyInput, AnyInput>
    ? InferResolvedValue<TResult>
    : never;

export type InferSourceInput<TSource> =
  TSource extends ResolverSource<unknown, AnyInput, infer TResolveInput> ? TResolveInput : never;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

interface RenderInterpolable {
  [Symbol.toPrimitive](hint: string): string;
  toString(): string;
  valueOf(): string;
}

export type RenderableValue<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? Array<RenderableValue<U>> & RenderInterpolable
    : T extends object
      ? { [K in keyof T]: RenderableValue<T[K]> } & RenderInterpolable
      : T;

export type UseFn = <TSource extends AnyResolverSource>(
  source: TSource,
  input: InferSourceInput<TSource>,
) => Promise<NonNullable<RenderableValue<InferSource<TSource>>>>;

export interface ComposeContext<TInput extends AnyInput> {
  input: TInput;
  use: UseFn;
}

export interface ComposeResult {
  system?: string;
  prompt?: string;
}

export type ComposeFn<TInput extends AnyInput> = (
  context: ComposeContext<TInput>,
) => ComposeResult | Promise<ComposeResult>;

export interface Definition<TInput extends AnyInput, TResolveInput extends AnyInput = TInput> {
  _id: string;
  _inputSchema: InputSchema<TResolveInput, TInput>;
  _maxTokens: number;
  _compose: ComposeFn<TInput>;
  _input?: TInput;
  _resolveInput?: TResolveInput;
}

export interface PromptTrace {
  systemTokens: number;
  promptTokens: number;
  totalTokens: number;
}

export interface SourceTrace {
  sourceId: string;
  kind: "value" | "rag";
  tags: SourceTag[];
  resolvedAt: Date;
  durationMs: number;
  itemCount?: number;
}

export interface Trace {
  version: 1;
  runId: string;
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sources: SourceTrace[];
  budget: {
    max: number | null;
    used: number;
    exceeded: boolean;
  };
  prompt: PromptTrace;
}

export interface ResolveResult {
  system?: string;
  prompt?: string;
  trace: Trace;
}

export interface ResolvePayload<TResolveInput extends AnyInput> {
  input: TResolveInput;
}

export interface WindowHandle<TResolveInput extends AnyInput> {
  id: string;
  resolve(payload: ResolvePayload<TResolveInput>): Promise<ResolveResult>;
}

export interface BudgeLogger {
  info?: (...args: unknown[]) => void;
}

export interface BudgeOptions {
  logger?: BudgeLogger;
  onTrace?: (trace: Trace) => void;
}
