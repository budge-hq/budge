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

export interface InputOptions extends SourceOptions {}

export interface InputSource<TKey extends string = string> {
  _type: "input";
  _key: TKey;
  _tags: SourceTag[];
}

export interface SourceResolveArgs<TInput extends AnyInput> {
  input: TInput;
}

/** Runtime marker for values created with `budge.sourceSet()` (non-enumerable). */
export const BudgeSourceSetBrand = Symbol.for("budge.sourceSet");
declare const BudgeSourceSetSourcesBrand: unique symbol;

export type SourceSetBrand<TSources extends Record<string, AnyResolverSource>> = {
  readonly [BudgeSourceSetBrand]: true;
  readonly [BudgeSourceSetSourcesBrand]?: TSources;
};

type FinalizeSourceId<
  TSource,
  TSourceId extends string,
  TAllSources extends Record<string, AnyResolverSource>,
> =
  TSource extends ResolverSource<
    infer TResult,
    infer TSourceInput,
    string,
    string,
    infer TDependencySources
  >
    ? ResolverSource<
        TResult,
        TSourceInput,
        TSourceId,
        FinalizeDependencyIds<TDependencySources, TAllSources>,
        TDependencySources
      >
    : never;

type SourceKeyForHandle<TSources extends Record<string, AnyResolverSource>, THandle> = {
  [K in keyof TSources]: [TSources[K]] extends [THandle] ? Extract<K, string> : never;
}[keyof TSources];

type FinalizeDependencyId<
  TDependencySource,
  TAlias extends string,
  TAllSources extends Record<string, AnyResolverSource>,
> =
  SourceKeyForHandle<TAllSources, TDependencySource> extends never
    ? TDependencySource extends ResolverSource<unknown, AnyInput, infer TDependencyId, string, any>
      ? string extends TDependencyId
        ? TAlias
        : TDependencyId
      : TAlias
    : SourceKeyForHandle<TAllSources, TDependencySource>;

type FinalizeDependencyIds<
  TDependencySources extends Record<string, AnyResolverSource>,
  TAllSources extends Record<string, AnyResolverSource>,
> = {
  [K in keyof TDependencySources]: FinalizeDependencyId<
    TDependencySources[K],
    Extract<K, string>,
    TAllSources
  >;
}[keyof TDependencySources] &
  string;

type FinalizeSourceSetSources<TSources extends Record<string, AnyResolverSource>> = {
  [K in keyof TSources]: FinalizeSourceId<TSources[K], Extract<K, string>, TSources>;
};

export type SourceSet<TSources extends Record<string, AnyResolverSource>> =
  FinalizeSourceSetSources<TSources> & SourceSetBrand<FinalizeSourceSetSources<TSources>>;

type StaticStringKeys<T> = string extends keyof T ? never : Extract<keyof T, string>;

export type SourceDepValues<TDeps extends Record<string, AnyResolverSource>> = {
  [K in keyof TDeps]: InferSource<AnyInput, TDeps[K]>;
};

type EffectiveSelectedSourceId<TSource, TSelectedKey extends string> =
  TSource extends ResolverSource<unknown, AnyInput, infer TSourceId, string, any>
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
  TDependencySources extends Record<string, AnyResolverSource> = Record<string, never>,
> {
  _type: "resolver";
  _internalId: string;
  _ownerSetId?: string;
  _registeredId?: TSourceId;
  _sourceKind?: "value" | "rag";
  _dependencyIdType?: TDependencyIds;
  _dependencyRefs?: readonly SourceDependencyRef[];
  _dependencySources?: Readonly<TDependencySources>;
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
  TDependencySources extends Record<string, AnyResolverSource> = Record<string, never>,
> = ResolverSource<TResult, TSourceInput, TSourceId, TDependencyIds, TDependencySources>;

export type RagSource<
  TSourceInput extends AnyInput = AnyInput,
  TSourceId extends string = string,
  TDependencyIds extends string = never,
  TDependencySources extends Record<string, AnyResolverSource> = Record<string, never>,
> = ResolverSource<RagItems, TSourceInput, TSourceId, TDependencyIds, TDependencySources>;

export type AnyResolverSource = ResolverSource<
  unknown,
  AnyInput,
  string,
  string,
  Record<string, AnyResolverSource>
>;

export type AnySource = InputSource<string> | AnyResolverSource;

type InferResolvedValue<TResult> = Awaited<TResult> extends RagItems ? Chunk[] : Awaited<TResult>;

type SourceDependencies<TSource> =
  TSource extends ResolverSource<unknown, AnyInput, string, infer TDependencyIds, any>
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
  : { __budge_missing_source_dependencies__: MissingDependencies<TSourceMap> };

export type SourceSetSources<TSourceSet> =
  TSourceSet extends SourceSetBrand<infer TSources extends Record<string, AnyResolverSource>>
    ? TSources
    : never;

type SourceSetKeys<TSourceSet> = StaticStringKeys<SourceSetSources<TSourceSet>>;

type DuplicateSourceSetKeys<
  TSourceSets extends readonly unknown[],
  TSeen extends string = never,
> = TSourceSets extends readonly [infer TFirst, ...infer TRest]
  ?
      | Extract<SourceSetKeys<TFirst>, TSeen>
      | DuplicateSourceSetKeys<TRest, TSeen | SourceSetKeys<TFirst>>
  : never;

export type EnforceUniqueSourceSetKeys<TSourceSets extends readonly unknown[]> = [
  DuplicateSourceSetKeys<TSourceSets>,
] extends [never]
  ? unknown
  : { __budge_duplicate_source_keys__: DuplicateSourceSetKeys<TSourceSets> };

type MergeSourceSetsUnchecked<
  TSourceSets extends readonly unknown[],
  TAccumulated extends Record<string, AnyResolverSource> = {},
> = TSourceSets extends readonly [infer TFirst, ...infer TRest]
  ? MergeSourceSetsUnchecked<TRest, TAccumulated & SourceSetSources<TFirst>>
  : TAccumulated;

export type MergeSourceSets<TSourceSets extends readonly unknown[]> = [
  DuplicateSourceSetKeys<TSourceSets>,
] extends [never]
  ? MergeSourceSetsUnchecked<TSourceSets>
  : { __budge_duplicate_source_keys__: DuplicateSourceSetKeys<TSourceSets> };

type CompatibleSource<TInput extends AnyInput, TSource> =
  TSource extends InputSource<infer TKey>
    ? TKey extends Extract<keyof TInput, string>
      ? TSource
      : never
    : TSource extends ResolverSource<unknown, infer TSourceInput, string, string, any>
      ? TSourceInput extends Partial<TInput>
        ? TSource
        : never
      : never;

export type SourceShape<TInput extends AnyInput, TSourceMap extends Record<string, unknown>> = {
  [K in Extract<keyof TSourceMap, string>]: CompatibleSource<TInput, TSourceMap[K]>;
};

type ReservedContextKey = "raw";

type ContextKeyCollisions<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
> = Extract<StaticStringKeys<TSources> | StaticStringKeys<TDerived>, ReservedContextKey>;

export type EnforceReservedContextKeys<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
> = [ContextKeyCollisions<TSources, TDerived>] extends [never]
  ? unknown
  : { __budge_reserved_context_keys__: ContextKeyCollisions<TSources, TDerived> };

type ConflictingDerivedKeys<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
> = Extract<StaticStringKeys<TDerived>, StaticStringKeys<TSources>>;

export type EnforceDerivedKeys<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
> = [ConflictingDerivedKeys<TSources, TDerived>] extends [never]
  ? unknown
  : { __budge_conflicting_derived_keys__: ConflictingDerivedKeys<TSources, TDerived> };

// ============================================================
// Infer resolved type from a source
// ============================================================

export type InferSource<TInput extends AnyInput, TSource> =
  TSource extends InputSource<infer TKey>
    ? TKey extends keyof TInput
      ? TInput[TKey]
      : never
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
> = (context: TSources) => TDerived;

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
> = (context: TSources & TDerived) => ExcludeDecision<TExcludedKey> | false;

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
 * In render mode, Phase 2 trimming drops `included[included.length - 1]`
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
// Rendering
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

export type RenderContext<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> = RenderableValue<AllowedContext<TSources, TDerived, TRequired>> & {
  raw: AllowedContext<TSources, TDerived, TRequired>;
};

export type RenderFn<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> = (context: RenderContext<TSources, TDerived, TRequired>) => string;

export type RenderValue<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
> = string | RenderFn<TSources, TDerived, TRequired>;

export interface PromptTrace {
  systemTokens: number;
  promptTokens: number;
  totalTokens: number;
  /** Token cost of naively JSON-stringifying all resolved source values before policy/budget filtering. */
  rawContextTokens: number;
  /** Token cost of naively JSON-stringifying the final rendered context after policy/budget filtering. */
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
  windowId: string;
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
  system?: string;
  prompt?: string;
  trace: Trace;
}

// ============================================================
// Context window (Definition)
// Built by budge.window(); call the returned function with input each turn.
// ============================================================

export type DefinitionConfig<
  TInput extends AnyInput,
  TSourceMap extends Record<string, unknown>,
  TDerived extends Record<string, unknown> = Record<string, never>,
  TRequired extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TPrefer extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
> = {
  id: string;
  sources: TSourceMap &
    SourceShape<TInput, NoInfer<TSourceMap>> &
    EnforceSourceDependencies<NoInfer<TSourceMap>>;
  derive?: DeriveFn<InferSources<TInput, TSourceMap>, TDerived>;
  policies?: Policies<InferSources<TInput, TSourceMap>, NoInfer<TDerived>, TRequired, TPrefer>;
  system?: RenderValue<InferSources<TInput, TSourceMap>, NoInfer<TDerived>, TRequired>;
  prompt?: RenderValue<InferSources<TInput, TSourceMap>, NoInfer<TDerived>, TRequired>;
} & EnforceDerivedKeys<InferSources<TInput, TSourceMap>, TDerived> &
  EnforceReservedContextKeys<InferSources<TInput, TSourceMap>, TDerived>;

/** Declared context window: sources, policies, and optional rendering for one agent turn. */
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
  _system: RenderValue<InferSources<TInput, TSourceMap>, TDerived, TRequired> | undefined;
  _prompt: RenderValue<InferSources<TInput, TSourceMap>, TDerived, TRequired> | undefined;
  _input?: TInput; // phantom type for inference only
  _resolveInput?: TResolveInput; // phantom type for inference only
}

export interface BudgeLogger {
  info?: (...args: unknown[]) => void;
}

export interface BudgeOptions {
  logger?: BudgeLogger;
  onTrace?: (trace: Trace) => void;
}

export type InferContext<T> =
  T extends Definition<
    infer TInput,
    infer TSourceMap,
    infer TDerived,
    infer TRequired,
    infer _TPrefer,
    infer _TResolveInput
  >
    ? AllowedContext<InferSources<TInput, TSourceMap>, TDerived, TRequired>
    : T extends (
          input: infer _I,
        ) => Promise<Resolution<infer TSources, infer TDerived, infer TRequired>>
      ? AllowedContext<TSources, TDerived, TRequired>
      : never;
