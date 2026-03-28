import { describe, expect, test } from "vite-plus/test";
import { greedyScore, scorePerToken, resolveStrategy } from "../src/strategies.ts";
import { estimateTokens } from "../src/pack.ts";
import type { BudgetStrategyContext, Chunk } from "../src/types.ts";

function ctx(budget: number): BudgetStrategyContext {
  return { budget, estimateTokens };
}

describe("greedyScore", () => {
  test("sorts by score descending and fits greedily", () => {
    const chunks: Chunk[] = [
      { content: "low", score: 0.1 },
      { content: "high", score: 0.9 },
      { content: "mid", score: 0.5 },
    ];
    const result = greedyScore(chunks, ctx(Infinity));
    expect(result.included.map((c) => c.score)).toEqual([0.9, 0.5, 0.1]);
    expect(result.included).toHaveLength(3);
  });

  test("treats missing score as 0", () => {
    const chunks: Chunk[] = [{ content: "scored", score: 0.5 }, { content: "unscored" }];
    const result = greedyScore(chunks, ctx(Infinity));
    expect(result.included[0]!.content).toBe("scored");
    expect(result.included[1]!.content).toBe("unscored");
  });

  test("with budget=0 includes nothing", () => {
    const chunks: Chunk[] = [{ content: "hello", score: 1 }];
    const result = greedyScore(chunks, ctx(0));
    expect(result.included).toHaveLength(0);
    expect(result.records[0]!.included).toBe(false);
    expect(result.records[0]!.reason).toBe("over_budget");
  });

  test("drops chunks that exceed remaining budget", () => {
    // Create chunks where the first high-score chunk uses most of the budget
    const big = "x".repeat(200);
    const small = "y".repeat(10);
    const chunks: Chunk[] = [
      { content: big, score: 0.9 },
      { content: small, score: 0.8 },
      { content: big, score: 0.7 },
    ];
    const bigTokens = estimateTokens(big);
    const smallTokens = estimateTokens(small);
    // Budget fits the big chunk + small chunk but not two big chunks
    const result = greedyScore(chunks, ctx(bigTokens + smallTokens));
    expect(result.included).toHaveLength(2);
    expect(result.included[0]!.score).toBe(0.9);
    expect(result.included[1]!.score).toBe(0.8);
  });
});

describe("scorePerToken", () => {
  test("prefers small high-score chunks over large high-score chunks", () => {
    const bigChunk: Chunk = { content: "x".repeat(200), score: 0.8 };
    const smallChunk: Chunk = { content: "y".repeat(20), score: 0.7 };
    const bigTokens = estimateTokens(bigChunk.content);
    const smallTokens = estimateTokens(smallChunk.content);

    // Budget only fits the small chunk (not the big one)
    const budget = Math.floor((bigTokens + smallTokens) / 2);
    const strategy = scorePerToken();

    const result = strategy([bigChunk, smallChunk], ctx(budget));
    // scorePerToken should prefer smallChunk (higher efficiency: 0.7/~5 vs 0.8/~50)
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.content).toBe(smallChunk.content);
  });

  test("with alpha=0 ranks purely by 1/tokenCost (smallest first)", () => {
    const big: Chunk = { content: "x".repeat(200), score: 1.0 };
    const small: Chunk = { content: "y".repeat(10), score: 0.1 };

    const strategy = scorePerToken({ alpha: 0 });
    const result = strategy([big, small], ctx(Infinity));
    // alpha=0 means score^0 = 1, so ranking is 1/tokens → small chunk first
    expect(result.included[0]!.content).toBe(small.content);
  });

  test("with alpha=2 heavily favors high-score chunks", () => {
    // Two chunks of similar size but different scores
    const highScore: Chunk = { content: "a".repeat(50), score: 0.9 };
    const lowScore: Chunk = { content: "b".repeat(40), score: 0.3 };

    const strategy = scorePerToken({ alpha: 2 });
    const result = strategy([lowScore, highScore], ctx(Infinity));
    // 0.9^2/tokens(50) vs 0.3^2/tokens(40) → highScore wins
    expect(result.included[0]!.content).toBe(highScore.content);
  });

  test("minChunkTokens floor prevents division by near-zero", () => {
    const empty: Chunk = { content: "", score: 0.5 };
    const normal: Chunk = { content: "hello world", score: 0.5 };

    const strategy = scorePerToken({ minChunkTokens: 1 });
    // Should not throw
    const result = strategy([empty, normal], ctx(Infinity));
    expect(result.included).toHaveLength(2);
  });

  test("produces different selection than greedyScore when sizes vary", () => {
    const big: Chunk = { content: "x".repeat(200), score: 0.9 };
    const small1: Chunk = { content: "a".repeat(30), score: 0.6 };
    const small2: Chunk = { content: "b".repeat(30), score: 0.5 };

    const bigTokens = estimateTokens(big.content);
    // Budget fits big alone OR both smalls, but not big + any small
    const budget = bigTokens + 1;

    const greedy = greedyScore([big, small1, small2], ctx(budget));
    const efficient = scorePerToken()([big, small1, small2], ctx(budget));

    // Greedy picks big first (highest score 0.9), leaving ~1 token —
    // neither small chunk fits afterward
    expect(greedy.included).toHaveLength(1);
    expect(greedy.included[0]!.score).toBe(0.9);

    // scorePerToken ranks by efficiency (score/tokens), so small chunks
    // rank higher and both fit, yielding 2 chunks instead of 1
    expect(efficient.included).toHaveLength(2);
    expect(efficient.included[0]!.score).toBe(0.6);
    expect(efficient.included[1]!.score).toBe(0.5);
  });
});

describe("resolveStrategy", () => {
  test("undefined returns greedyScore", () => {
    expect(resolveStrategy(undefined)).toBe(greedyScore);
  });

  test('{ type: "greedy_score" } returns greedyScore', () => {
    expect(resolveStrategy({ type: "greedy_score" })).toBe(greedyScore);
  });

  test('{ type: "score_per_token" } returns a function', () => {
    const fn = resolveStrategy({ type: "score_per_token" });
    expect(typeof fn).toBe("function");
    expect(fn).not.toBe(greedyScore);
  });

  test("custom function is passed through", () => {
    const custom = () => ({ included: [], records: [], tokensUsed: 0 });
    expect(resolveStrategy(custom)).toBe(custom);
  });

  test("unknown type throws", () => {
    expect(() => resolveStrategy({ type: "unknown" } as never)).toThrow(
      "Unknown budget strategy type: unknown",
    );
  });
});
