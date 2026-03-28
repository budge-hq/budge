import type {
  BudgetStrategy,
  BudgetStrategyContext,
  BudgetStrategyFn,
  Chunk,
  ChunkRecord,
  PackedResult,
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
    default:
      throw new Error(`Unknown budget strategy type: ${(strategy as { type: string }).type}`);
  }
}
