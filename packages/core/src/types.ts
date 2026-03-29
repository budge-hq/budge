import type { StandardSchemaV1 } from "@standard-schema/spec";

// ============================================================
// Input
// ============================================================

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

// ============================================================
// Tags
// ============================================================

export type SourceTag = string;

// ============================================================
// RAG items
// ============================================================

export interface Chunk {
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RagItems {
  _type: "rag";
  items: Chunk[];
}

// ============================================================
// Source definitions
// ============================================================

export interface SourceOptions {
  tags?: SourceTag[];
}

export interface FromInputSourceOptions extends SourceOptions {}

export interface InputSource<TKey extends string = string> {
  _type: "input";
  _key: TKey;
  _tags: SourceTag[];
}

export interface SourceResolveArgs<TInput extends AnyInput> {
  input: TInput;
}

export interface SourceSetBrand<TSources extends Record<string, AnyResolverSource>> {
  readonly _sourceSet: true;
  readonly _sources?: TSources;
}

type FinalizeSourceId<TSource, TSourceId extends string> =
  TSource extends ResolverSource<infer TResult, infer TSourceInput, string, infer TDependencyIds>
    ? ResolverSource<TResult, TSourceInput, TSourceId, TDependencyIds>
    : never;

type FinalizeSourceSetSources<TSources extends Record<string, AnyResolverSource>> = {
  [K in keyof TSources]: FinalizeSourceId<TSources[K], Extract<K, string>>;
};

export type SourceSet<TSources extends Record<string, AnyResolverSource>> =
  FinalizeSourceSetSources<TSources> & SourceSetBrand<FinalizeSourceSetSources<TSources>>;

export type SourceDepValues<TDeps extends Record<string, AnyResolverSource>> = {
  [K in keyof TDeps]: InferSource<AnyInput, TDeps[K]>;
};

type EffectiveSelectedSourceId<TSource, TSelectedKey extends string> =
  TSource extends ResolverSource<unknown, AnyInput, infer TSourceId, string>
    ? string extends TSourceId
      ? TSelectedKey
      : TSourceId
    : never;

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

export interface SourceDependencyRef {
  alias: string;
  internalId: string;
  registeredId?: string;
}

export interface ResolverSource<
  TResult = unknown,
  TSourceInput extends AnyInput = AnyInput,
  TSourceId extends string = string,
  TDependencyIds extends string = never,
> {
  _type: "resolver";
  _internalId: string;
  _ownerSetId?: string;
  _registeredId?: TSourceId;
  _sourceKind?: "value" | "rag";
  _dependencyIdType?: TDependencyIds;
  _dependencyRefs?: readonly SourceDependencyRef[];
  _dependencySources?: Readonly<Record<string, AnyResolverSource>>;
  resolve(input: AnyInput, context: Record<string, unknown>): Promise<TResult>;
  output?: AnySchema;
  tags?: SourceTag[];
  _input?: TSourceInput;
}

export type ValueSource<
  TResult = unknown,
  TSourceInput extends AnyInput = AnyInput,
  TSourceId extends string = string,
  TDependencyIds extends string = never,
> = ResolverSource<TResult, TSourceInput, TSourceId, TDependencyIds>;

export type RagSource<
  TSourceInput extends AnyInput = AnyInput,
  TSourceId extends string = string,
  TDependencyIds extends string = never,
> = ResolverSource<RagItems, TSourceInput, TSourceId, TDependencyIds>;

export type AnyResolverSource = ResolverSource<unknown, AnyInput, string, string>;

export type AnySource = InputSource<string> | AnyResolverSource;

type InferResolvedValue<TResult> = Awaited<TResult> extends RagItems ? Chunk[] : Awaited<TResult>;

type SourceDependencies<TSource> =
  TSource extends ResolverSource<unknown, AnyInput, string, infer TDependencyIds>
    ? TDependencyIds
    : never;

type SelectedSourceIds<TSourceMap extends Record<string, unknown>> = {
  [K in Extract<keyof TSourceMap, string>]: EffectiveSelectedSourceId<TSourceMap[K], K>;
}[Extract<keyof TSourceMap, string>];

type MissingDependencies<TSourceMap extends Record<string, unknown>> = {
  [K in Extract<keyof TSourceMap, string>]: Exclude<
    SourceDependencies<TSourceMap[K]>,
    SelectedSourceIds<TSourceMap>
  > extends never
    ? never
    : {
        source: K;
        missing: Exclude<SourceDependencies<TSourceMap[K]>, SelectedSourceIds<TSourceMap>>;
      };
}[Extract<keyof TSourceMap, string>];

export type EnforceSourceDependencies<TSourceMap extends Record<string, unknown>> = [
  MissingDependencies<TSourceMap>,
] extends [never]
  ? unknown
  : { __polo_missing_source_dependencies__: MissingDependencies<TSourceMap> };

export type SourceSetSources<TSourceSet> =
  TSourceSet extends SourceSetBrand<infer TSources extends Record<string, AnyResolverSource>>
    ? TSources
    : never;

export type MergeSourceSets<
  TSourceSets extends readonly unknown[],
  TAccumulated extends Record<string, AnyResolverSource> = {},
> = TSourceSets extends readonly [infer TFirst, ...infer TRest]
  ? MergeSourceSets<TRest, TAccumulated & SourceSetSources<TFirst>>
  : TAccumulated;

type CompatibleSource<TInput extends AnyInput, TSource> =
  TSource extends InputSource<infer TKey>
    ? TKey extends Extract<keyof TInput, string>
      ? TSource
      : never
    : TSource extends ResolverSource<unknown, infer TSourceInput, string, string>
      ? TSourceInput extends Partial<TInput>
        ? TSource
        : never
      : never;

export type SourceShape<TInput extends AnyInput, TSourceMap extends Record<string, unknown>> = {
  [K in keyof TSourceMap]: CompatibleSource<TInput, TSourceMap[K]>;
};

// ============================================================
// Infer resolved type from a source
// ============================================================

export type InferSource<TInput extends AnyInput, TSource> =
  TSource extends InputSource<infer TKey>
    ? TKey extends keyof TInput
      ? TInput[TKey]
      : never
    : TSource extends { output: infer TSchema extends AnySchema }
      ? StandardSchemaV1.InferOutput<TSchema>
      : TSource extends { resolve: (...args: never[]) => infer TResult }
        ? InferResolvedValue<TResult>
        : never;

export type InferSources<TInput extends AnyInput, TSourceMap extends Record<string, unknown>> = {
  [K in keyof TSourceMap]: InferSource<TInput, TSourceMap[K]>;
};

// ============================================================
// Derive
// ============================================================

export type DeriveFn<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
> = (resolved: { context: TSources }) => TDerived;

// ============================================================
// Policies
// ============================================================

export interface ExcludeDecision<TSourceKey extends string = string> {
  source: TSourceKey;
  reason: string;
}

export type PolicyExcludeFn<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TExcludedKey extends string = Extract<keyof TSources, string>,
> = (resolved: { context: TSources & TDerived }) => ExcludeDecision<TExcludedKey> | false;

export interface Policies<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
  TPrefer extends readonly Extract<keyof TSources, string>[] = [],
> {
  require?: TRequired;
  prefer?: TPrefer;
  exclude?: Array<
    PolicyExcludeFn<TSources, TDerived, Exclude<Extract<keyof TSources, string>, TRequired[number]>>
  >;
  budget?: number | BudgetConfig;
}

// ============================================================
// Budget strategies
// ============================================================

export interface BudgetStrategyContext {
  budget: number;
  estimateTokens: (text: string) => number;
}

export interface PackedResult {
  included: Chunk[];
  records: ChunkRecord[];
  tokensUsed: number;
}

/**
 * A function that selects and orders chunks for a token budget.
 *
 * The returned `included` array MUST be ordered most-valuable-first.
 * In template mode, Phase 2 trimming drops `included[included.length - 1]`
 * to stay within budget, so the last element should be the chunk the
 * strategy considers least important.
 */
export type BudgetStrategyFn = (chunks: Chunk[], ctx: BudgetStrategyContext) => PackedResult;

export interface ScorePerTokenOptions {
  /**
   * Exponent applied to score before dividing by token cost. Default: 1.
   * At alpha=0, score^0=1 for all scores so ranking is purely by 1/tokenCost.
   * At alpha>0, zero-scored chunks receive efficiency=0 and rank last.
   */
  alpha?: number;
  /** Floor for token cost to prevent division by near-zero. Default: 1. */
  minChunkTokens?: number;
}

export type BuiltinBudgetStrategy =
  | { type: "greedy_score" }
  | { type: "score_per_token"; options?: ScorePerTokenOptions };

export type BudgetStrategy = BuiltinBudgetStrategy | BudgetStrategyFn;

export interface BudgetConfig {
  maxTokens: number;
  strategy?: BudgetStrategy;
}

// ============================================================
// Template
// ============================================================

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

export type TemplateContext<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> = RenderableValue<AllowedContext<TSources, TDerived, TRequired>> & {
  raw: AllowedContext<TSources, TDerived, TRequired>;
};

export interface PromptOutput {
  system: string;
  prompt: string;
}

export type TemplateFn<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> = (args: { context: TemplateContext<TSources, TDerived, TRequired> }) => PromptOutput;

export interface PromptTrace {
  systemTokens: number;
  promptTokens: number;
  totalTokens: number;
  /** Token cost of naively JSON-stringifying all resolved source values before policy/budget filtering. */
  rawContextTokens: number;
  /** Token cost of naively JSON-stringifying the final template context after policy/budget filtering. */
  includedContextTokens: number;
  /** Clamped fraction of tokens saved vs all resolved sources: max(0, 1 - totalTokens / rawContextTokens). */
  compressionRatio: number;
  /** Clamped fraction of tokens saved vs the final included context: max(0, 1 - totalTokens / includedContextTokens). */
  includedCompressionRatio: number;
}

// ============================================================
// Trace
// ============================================================

export interface ChunkRecord {
  content: string;
  score?: number;
  included: boolean;
  reason?: string;
}

/** Discriminant for each entry in `Trace.sources`. */
export type SourceRecordType = "input" | "value" | "rag";

type SourceRecordBase = {
  key: string;
  resolvedAt: Date;
  durationMs: number;
  tags: SourceTag[];
};

export type SourceRecord =
  | (SourceRecordBase & { type: "input" | "value"; items?: never })
  | (SourceRecordBase & { type: "rag"; items: ChunkRecord[] });

export interface PolicyRecord {
  source: string;
  action: "included" | "excluded" | "required" | "preferred" | "dropped";
  reason: string;
}

export interface Trace {
  runId: string;
  taskId: string;
  startedAt: Date;
  completedAt: Date;
  sources: SourceRecord[];
  policies: PolicyRecord[];
  derived: Record<string, unknown>;
  budget: { max: number; used: number; strategy?: string; candidates?: number; selected?: number };
  prompt?: PromptTrace;
}

// ============================================================
// Resolution — authoritative
// ============================================================

type RequiredSourceContext<
  TSources extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[],
> = {
  [K in Extract<TRequired[number], keyof TSources>]-?: NonNullable<TSources[K]>;
};

type OptionalSourceContext<
  TSources extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[],
> = Partial<Omit<TSources, Extract<TRequired[number], keyof TSources>>>;

export type AllowedContext<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> = RequiredSourceContext<TSources, TRequired> &
  OptionalSourceContext<TSources, TRequired> &
  TDerived;

export interface Resolution<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> {
  context: AllowedContext<TSources, TDerived, TRequired>;
  prompt?: PromptOutput;
  trace: Trace;
}

// ============================================================
// Definition
// ============================================================

export interface DefinitionConfig<
  TInput extends AnyInput,
  TSourceMap extends Record<string, unknown>,
  TDerived extends Record<string, unknown> = Record<string, never>,
  TRequired extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TPrefer extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
> {
  id: string;
  sources: TSourceMap &
    SourceShape<TInput, NoInfer<TSourceMap>> &
    EnforceSourceDependencies<NoInfer<TSourceMap>>;
  derive?: DeriveFn<InferSources<TInput, TSourceMap>, TDerived>;
  policies?: Policies<InferSources<TInput, TSourceMap>, NoInfer<TDerived>, TRequired, TPrefer>;
  template?: TemplateFn<InferSources<TInput, TSourceMap>, NoInfer<TDerived>, TRequired>;
}

export interface Definition<
  TInput extends AnyInput,
  TSourceMap extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TPrefer extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TResolveInput extends AnyInput = TInput,
> {
  _id: string;
  _inputSchema: InputSchema<TResolveInput, TInput>;
  _sources: TSourceMap;
  _derive: DeriveFn<InferSources<TInput, TSourceMap>, TDerived> | undefined;
  _policies: Policies<InferSources<TInput, TSourceMap>, TDerived, TRequired, TPrefer>;
  _template: TemplateFn<InferSources<TInput, TSourceMap>, TDerived, TRequired> | undefined;
  _input?: TInput; // phantom type for inference only
  _resolveInput?: TResolveInput; // phantom type for inference only
}

export interface PoloLogger {
  info?: (...args: unknown[]) => void;
}

export interface PoloOptions {
  logger?: PoloLogger;
  onTrace?: (trace: Trace) => void;
}

export type InferContext<TDefinition> =
  TDefinition extends Definition<
    infer TInput,
    infer TSourceMap,
    infer TDerived,
    infer TRequired,
    infer _TPrefer,
    infer _TResolveInput
  >
    ? AllowedContext<InferSources<TInput, TSourceMap>, TDerived, TRequired>
    : never;
