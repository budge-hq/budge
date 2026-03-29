import type {
  BudgetStrategy,
  BudgetStrategyContext,
  BudgetStrategyFn,
  Chunk,
  ChunkRecord,
  PackedResult,
  QuotaByGroupOptions,
  RankBudgetStrategy,
  ScorePerTokenOptions,
} from "./types.ts";

/**
 * Greedy-by-score strategy (default).
 * Sorts chunks by score descending and includes them while they fit the budget.
 */
export const greedyScore: BudgetStrategyFn = (
  chunks: Chunk[],
  ctx: BudgetStrategyContext,
): PackedResult => {
  const sorted = [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const included: Chunk[] = [];
  const records: ChunkRecord[] = [];
  let tokensUsed = 0;

  for (const chunk of sorted) {
    const tokens = ctx.estimateTokens(chunk.content);

    if (tokensUsed + tokens <= ctx.budget) {
      included.push(chunk);
      tokensUsed += tokens;
      records.push({ content: chunk.content, score: chunk.score, included: true });
    } else {
      records.push({
        content: chunk.content,
        score: chunk.score,
        included: false,
        reason: "over_budget",
      });
    }
  }

  return { included, records, tokensUsed };
};

/**
 * Score-per-token strategy.
 * Ranks chunks by `score^alpha / tokenCost` (efficiency), then greedily fits.
 * Better when long chunks would otherwise crowd out multiple medium-good chunks.
 */
export function scorePerToken(options?: ScorePerTokenOptions): BudgetStrategyFn {
  const alpha = options?.alpha ?? 1;
  const minChunkTokens = options?.minChunkTokens ?? 1;

  if (!Number.isFinite(alpha) || alpha < 0) {
    throw new RangeError("score_per_token: alpha must be a finite number >= 0.");
  }

  if (!Number.isFinite(minChunkTokens) || minChunkTokens < 1) {
    throw new RangeError("score_per_token: minChunkTokens must be a finite number >= 1.");
  }

  return (chunks: Chunk[], ctx: BudgetStrategyContext): PackedResult => {
    const withEfficiency = chunks.map((chunk, index) => {
      const actualTokens = ctx.estimateTokens(chunk.content);
      const tokensForEfficiency = Math.max(minChunkTokens, actualTokens);
      const score = Math.max(0, chunk.score ?? 0);
      const efficiency = Math.pow(score, alpha) / tokensForEfficiency;
      return { chunk, score, actualTokens, efficiency, index };
    });

    withEfficiency.sort((a, b) => {
      const efficiencyDelta = b.efficiency - a.efficiency;
      if (efficiencyDelta !== 0) return efficiencyDelta;

      // With alpha=0, callers explicitly request pure token-efficiency ordering
      // (score^0 / tokens), so score must not act as a secondary key.
      const scoreDelta = alpha > 0 ? b.score - a.score : 0;
      if (scoreDelta !== 0) return scoreDelta;

      const tokenDelta = a.actualTokens - b.actualTokens;
      if (tokenDelta !== 0) return tokenDelta;

      return a.index - b.index;
    });

    const included: Chunk[] = [];
    const records: ChunkRecord[] = [];
    let tokensUsed = 0;

    for (const { chunk, actualTokens } of withEfficiency) {
      if (tokensUsed + actualTokens <= ctx.budget) {
        included.push(chunk);
        tokensUsed += actualTokens;
        records.push({ content: chunk.content, score: chunk.score, included: true });
      } else {
        records.push({
          content: chunk.content,
          score: chunk.score,
          included: false,
          reason: "over_budget",
        });
      }
    }

    return { included, records, tokensUsed };
  };
}

function resolveRankStrategy(strategy: RankBudgetStrategy | undefined): BudgetStrategyFn {
  if (strategy === undefined) return greedyScore;
  return strategy.type === "greedy_score" ? greedyScore : scorePerToken(strategy.options);
}

interface RankedEntry {
  chunk: Chunk;
  index: number;
  tokens: number;
  group: string;
}

function rankEntries(
  entries: RankedEntry[],
  strategyFn: BudgetStrategyFn,
  estimateTokens: (text: string) => number,
): RankedEntry[] {
  if (entries.length === 0) return [];

  const order = strategyFn(
    entries.map((entry) => entry.chunk),
    { budget: Number.POSITIVE_INFINITY, estimateTokens },
  ).included;

  const byChunk = new Map<Chunk, RankedEntry[]>();
  for (const entry of entries) {
    const list = byChunk.get(entry.chunk);
    if (list) {
      list.push(entry);
    } else {
      byChunk.set(entry.chunk, [entry]);
    }
  }

  return order.map((chunk) => byChunk.get(chunk)!.shift()!);
}

function makeGroupSelector(options: QuotaByGroupOptions): (chunk: Chunk) => string {
  const defaultGroup = options.defaultGroup?.trim() || "ungrouped";
  const groupBy = options.groupBy;

  if (typeof groupBy === "function") {
    return (chunk) => {
      const group = groupBy(chunk)?.trim();
      return group && group.length > 0 ? group : defaultGroup;
    };
  }

  const field = groupBy.slice("metadata.".length).trim();
  if (field.length === 0) {
    throw new RangeError('quota_by_group: groupBy must use non-empty "metadata.<field>".');
  }

  return (chunk) => {
    const value = chunk.metadata?.[field];
    if (typeof value === "string") {
      const group = value.trim();
      if (group.length > 0) return group;
    }
    return defaultGroup;
  };
}

function validateQuotaOptions(options: QuotaByGroupOptions): void {
  const entries = Object.entries(options.quotas);
  if (entries.length === 0) {
    throw new RangeError("quota_by_group: quotas must define at least one group ratio.");
  }

  let total = 0;
  for (const [group, ratio] of entries) {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new RangeError(
        `quota_by_group: quota for group "${group}" must be a finite ratio between 0 and 1.`,
      );
    }
    total += ratio;
  }

  if (total > 1) {
    throw new RangeError("quota_by_group: sum of quota ratios must be <= 1.");
  }
}

/**
 * Quota-by-group strategy.
 *
 * 1) Allocate per-group quota shares first.
 * 2) Fill remaining budget globally.
 */
export function quotaByGroup(options: QuotaByGroupOptions): BudgetStrategyFn {
  validateQuotaOptions(options);

  const selectGroup = makeGroupSelector(options);
  const intraGroup = resolveRankStrategy(options.intraGroup);
  const fill = resolveRankStrategy(options.fill);

  return (chunks: Chunk[], ctx: BudgetStrategyContext): PackedResult => {
    const entries: RankedEntry[] = chunks.map((chunk, index) => ({
      chunk,
      index,
      tokens: ctx.estimateTokens(chunk.content),
      group: selectGroup(chunk),
    }));

    const globalRanked = rankEntries(entries, fill, ctx.estimateTokens);
    if (!Number.isFinite(ctx.budget)) {
      return {
        included: globalRanked.map((entry) => entry.chunk),
        records: globalRanked.map((entry) => ({
          content: entry.chunk.content,
          score: entry.chunk.score,
          included: true,
        })),
        tokensUsed: entries.reduce((sum, entry) => sum + entry.tokens, 0),
      };
    }

    const grouped = new Map<string, RankedEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.group);
      if (list) {
        list.push(entry);
      } else {
        grouped.set(entry.group, [entry]);
      }
    }

    const included = new Set<number>();
    let tokensUsed = 0;

    for (const [group, ratio] of Object.entries(options.quotas)) {
      const groupEntries = grouped.get(group);
      if (!groupEntries || groupEntries.length === 0 || ratio === 0) continue;

      const groupBudget = Math.floor(ctx.budget * ratio);
      if (groupBudget <= 0) continue;

      const ranked = rankEntries(groupEntries, intraGroup, ctx.estimateTokens);
      let groupTokensUsed = 0;

      for (const entry of ranked) {
        if (included.has(entry.index)) continue;
        if (groupTokensUsed + entry.tokens > groupBudget) continue;
        if (tokensUsed + entry.tokens > ctx.budget) continue;

        included.add(entry.index);
        groupTokensUsed += entry.tokens;
        tokensUsed += entry.tokens;
      }
    }

    for (const entry of globalRanked) {
      if (included.has(entry.index)) continue;
      if (tokensUsed + entry.tokens > ctx.budget) continue;

      included.add(entry.index);
      tokensUsed += entry.tokens;
    }

    const includedChunks: Chunk[] = [];
    const records: ChunkRecord[] = [];

    for (const entry of globalRanked) {
      if (included.has(entry.index)) {
        includedChunks.push(entry.chunk);
        records.push({ content: entry.chunk.content, score: entry.chunk.score, included: true });
      } else {
        records.push({
          content: entry.chunk.content,
          score: entry.chunk.score,
          included: false,
          reason: "over_budget",
        });
      }
    }

    return { included: includedChunks, records, tokensUsed };
  };
}

/**
 * Resolve a `BudgetStrategy` value into a concrete `BudgetStrategyFn`.
 * - `undefined` → `greedyScore`
 * - Built-in discriminated union → corresponding function
 * - Custom function → passed through
 */
export function resolveStrategy(strategy: BudgetStrategy | undefined): BudgetStrategyFn {
  if (strategy === undefined) return greedyScore;
  if (typeof strategy === "function") return strategy;

  switch (strategy.type) {
    case "greedy_score":
      return greedyScore;
    case "score_per_token":
      return scorePerToken(strategy.options);
    case "quota_by_group":
      return quotaByGroup(strategy.options);
    default:
      throw new Error(`Unknown budget strategy type: ${(strategy as { type: string }).type}`);
  }
}
