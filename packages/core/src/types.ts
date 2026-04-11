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

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageKind = "tool_call" | "tool_result" | "reasoning" | "text";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  kind?: MessageKind;
  createdAt?: Date;
}

export interface Chunk {
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SourceDependencyRef {
  alias: string;
  sourceId: string;
  sourceKey: string;
}

export interface SourceOptions {
  tags?: SourceTag[];
}

export interface FromInputSourceOptions extends SourceOptions {}

export interface InputSource<TKey extends string = string> {
  _type: "input";
  _internalId: string;
  _sourceKind: "input";
  _key: TKey;
  _tags: SourceTag[];
}

export interface SourceResolveArgs<TInput extends AnyInput> {
  input: TInput;
}

export type SourceDepValues<TDeps extends Record<string, AnyResolverSource>> = {
  [K in keyof TDeps]: InferSource<TDeps[K]>;
};

export interface SourceConfig<
  TInput extends AnyInput = AnyInput,
  TOutput = unknown,
> extends SourceOptions {
  output?: AnySchema;
  resolve(args: SourceResolveArgs<TInput>): Promise<TOutput> | TOutput;
}

export interface DependentSourceConfig<
  TInput extends AnyInput = AnyInput,
  TDeps extends Record<string, AnyResolverSource> = Record<string, AnyResolverSource>,
  TOutput = unknown,
> extends SourceOptions {
  output?: AnySchema;
  resolve(args: SourceResolveArgs<TInput> & SourceDepValues<TDeps>): Promise<TOutput> | TOutput;
}

export interface RagSourceConfig<
  TInput extends AnyInput = AnyInput,
  TItem = Chunk,
> extends SourceOptions {
  output?: AnySchema;
  normalize?: (item: TItem) => Chunk;
  resolve(args: SourceResolveArgs<TInput>): Promise<TItem[] | Chunk[]> | TItem[] | Chunk[];
}

export interface DependentRagSourceConfig<
  TInput extends AnyInput = AnyInput,
  TDeps extends Record<string, AnyResolverSource> = Record<string, AnyResolverSource>,
  TItem = Chunk,
> extends SourceOptions {
  output?: AnySchema;
  normalize?: (item: TItem) => Chunk;
  resolve(
    args: SourceResolveArgs<TInput> & SourceDepValues<TDeps>,
  ): Promise<TItem[] | Chunk[]> | TItem[] | Chunk[];
}

export interface HistoryCompactionConfig {
  strategy: "sliding";
  maxMessages?: number;
}

export interface HistoryFilterConfig {
  excludeKinds?: MessageKind[];
}

export interface HistorySourceConfig<TInput extends AnyInput = AnyInput> extends SourceOptions {
  resolve(args: SourceResolveArgs<TInput>): Promise<Message[]> | Message[];
  filter?: HistoryFilterConfig;
  compaction?: HistoryCompactionConfig;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCollision {
  name: string;
  winner: "static" | "mcp";
  loser: "static" | "mcp";
}

export interface MCPClientLike {
  // Transport-agnostic by design: Budge only relies on a tools() method and does
  // not care whether the client talks to MCP over stdio, HTTP, SSE, or something else.
  tools(): Promise<
    Record<
      string,
      {
        description?: string;
        inputSchema?: Record<string, unknown>;
      }
    >
  >;
}

export interface ToolsSourceConfig extends SourceOptions {
  tools?: Record<
    string,
    {
      description?: string;
      inputSchema: Record<string, unknown>;
    }
  >;
  mcp?: MCPClientLike | MCPClientLike[];
  normalize?: (name: string, raw: Record<string, unknown>) => ToolDefinition;
}

export interface ResolverSource<TResult = unknown, TResolveInput extends AnyInput = AnyInput> {
  _type: "resolver";
  _internalId: string;
  _sourceKind: "value" | "rag";
  _dependencySources: Readonly<Record<string, AnyResolverSource>>;
  output?: AnySchema;
  tags?: SourceTag[];
  resolve(input: TResolveInput, context?: Record<string, unknown>): Promise<TResult>;
}

export type ValueSource<
  TResult = unknown,
  TResolveInput extends AnyInput = AnyInput,
> = ResolverSource<TResult, TResolveInput>;

export type RagSource<TResolveInput extends AnyInput = AnyInput> = ResolverSource<
  Chunk[],
  TResolveInput
>;

export interface HistorySource<TResolveInput extends AnyInput = AnyInput> {
  _type: "resolver";
  _internalId: string;
  _sourceKind: "history";
  _dependencySources: Record<string, never>;
  tags: SourceTag[];
  resolve(input: TResolveInput, context?: Record<string, unknown>): Promise<Message[]>;
}

export interface ToolsSource {
  _type: "resolver";
  _internalId: string;
  _sourceKind: "tools";
  _dependencySources: Record<string, never>;
  tags: SourceTag[];
  resolve(
    input: AnyInput,
    context?: Record<string, unknown>,
  ): Promise<Record<string, ToolDefinition>>;
}

export type AnyResolverSource = ResolverSource<unknown, AnyInput>;

export type AnySource =
  | InputSource<string>
  | AnyResolverSource
  | HistorySource<AnyInput>
  | ToolsSource;

type InferResolvedValue<TResult> = Awaited<TResult>;

export type InferSource<TSource extends AnyResolverSource> = TSource extends {
  output: infer TSchema extends AnySchema;
}
  ? InferSchemaOutput<TSchema>
  : TSource extends { resolve: (...args: never[]) => infer TResult }
    ? InferResolvedValue<TResult>
    : never;

type CompatibleSource<TInput extends AnyInput, TSource> =
  TSource extends InputSource<infer TKey>
    ? TKey extends Extract<keyof TInput, string>
      ? TSource
      : never
    : TSource extends ToolsSource
      ? TSource
      : TSource extends HistorySource<infer TSourceInput>
        ? TSourceInput extends Partial<TInput>
          ? TSource
          : never
        : TSource extends ResolverSource<unknown, infer TSourceInput>
          ? TSourceInput extends Partial<TInput>
            ? TSource
            : never
          : never;

export type SourceShape<TInput extends AnyInput, TSourceMap extends Record<string, unknown>> = {
  [K in keyof TSourceMap]: CompatibleSource<TInput, TSourceMap[K]>;
};

export type InferWindowSource<TInput extends AnyInput, TSource> =
  TSource extends InputSource<infer TKey>
    ? TKey extends keyof TInput
      ? TInput[TKey]
      : never
    : TSource extends ToolsSource
      ? Record<string, ToolDefinition>
      : TSource extends HistorySource<AnyInput>
        ? Message[]
        : TSource extends AnyResolverSource
          ? InferSource<TSource>
          : never;

export type InferSources<TInput extends AnyInput, TSourceMap extends Record<string, unknown>> = {
  [K in keyof TSourceMap]: InferWindowSource<TInput, TSourceMap[K]>;
};

export interface Wave {
  keys: string[];
}

export interface ExecutionPlan {
  waves: Wave[];
  dependenciesBySourceKey: Map<string, SourceDependencyRef[]>;
}

export interface WindowSpec<
  TWindowInput extends AnyInput,
  TResolveInput extends AnyInput = TWindowInput,
  TSourceMap extends Record<string, AnySource> = Record<string, AnySource>,
> {
  _id: string;
  _inputSchema: InputSchema<TResolveInput, TWindowInput>;
  _sources: TSourceMap;
  _plan: ExecutionPlan;
}

export interface SourceTrace {
  key: string;
  fingerprint: string;
  sourceId: string;
  kind: "input" | "value" | "rag" | "history" | "tools";
  tags: SourceTag[];
  dependsOn: string[];
  completedAt: Date;
  durationMs: number;
  status: "resolved" | "failed";
  estimatedTokens?: number;
  contentLength?: number;
  contentHash?: string;
  itemCount?: number;
  totalMessages?: number;
  includedMessages?: number;
  droppedMessages?: number;
  droppedByKind?: Record<string, number>;
  compactionDroppedMessages?: number;
  strategy?: "sliding";
  maxMessages?: number;
  totalTools?: number;
  includedTools?: number;
  droppedTools?: number;
  toolNames?: string[];
  toolSources?: {
    static: string[];
    mcp: string[];
  };
  toolCollisions?: ToolCollision[];
}

export interface Trace {
  version: 1;
  runId: string;
  sessionId?: string;
  turnIndex?: number;
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sources: SourceTrace[];
}

export interface ResolveResult<TContext extends Record<string, unknown> = Record<string, unknown>> {
  context: TContext;
  traces: Trace;
}

export interface ResolvePayload<TResolveInput extends AnyInput> {
  input: TResolveInput;
  sessionId?: string;
  turnIndex?: number;
}

export interface WindowHandle<
  TResolveInput extends AnyInput,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  resolve(payload: ResolvePayload<TResolveInput>): Promise<ResolveResult<TContext>>;
}

export interface BudgeLogger {
  info?: (...args: unknown[]) => void;
}

export interface BudgeTokenizer {
  // Receives a pre-serialized string. Returns estimated token count.
  // Must never throw - wrap in try/catch at the call site.
  estimate(text: string): number;
}

export interface BudgeOptions {
  logger?: BudgeLogger;
  onTrace?: (trace: Trace) => void;
  tokenizer?: BudgeTokenizer;
}
