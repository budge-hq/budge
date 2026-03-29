import { describe, expect, test } from "vite-plus/test";
import { greedyScore, quotaByGroup, scorePerToken, resolveStrategy } from "../src/strategies.ts";
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
  test("throws when alpha is negative", () => {
    expect(() => scorePerToken({ alpha: -1 })).toThrow(
      "score_per_token: alpha must be a finite number >= 0.",
    );
  });

  test("throws when minChunkTokens is less than 1", () => {
    expect(() => scorePerToken({ minChunkTokens: 0 })).toThrow(
      "score_per_token: minChunkTokens must be a finite number >= 1.",
    );
  });

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

  test("with alpha=0 and equal token cost, score does not break ties", () => {
    const strategy = scorePerToken({ alpha: 0 });
    const result = strategy(
      [
        { content: "first", score: 10 },
        { content: "second", score: 1 },
      ],
      {
        budget: Infinity,
        estimateTokens() {
          return 10;
        },
      },
    );

    expect(result.included[0]!.content).toBe("first");
    expect(result.included[1]!.content).toBe("second");
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

  test("ties on efficiency are broken by higher score", () => {
    const strategy = scorePerToken();
    const result = strategy(
      [
        { content: "a", score: 1 },
        { content: "bb", score: 2 },
      ],
      {
        budget: Infinity,
        estimateTokens(content) {
          if (content === "a") return 10;
          if (content === "bb") return 20;
          return 1;
        },
      },
    );

    expect(result.included[0]!.content).toBe("bb");
    expect(result.included[1]!.content).toBe("a");
  });

  test("ties on efficiency and score are broken by lower actual token cost", () => {
    const strategy = scorePerToken({ minChunkTokens: 100 });
    const result = strategy(
      [
        { content: "small", score: 1 },
        { content: "large", score: 1 },
      ],
      {
        budget: Infinity,
        estimateTokens(content) {
          if (content === "small") return 10;
          if (content === "large") return 20;
          return 1;
        },
      },
    );

    expect(result.included[0]!.content).toBe("small");
    expect(result.included[1]!.content).toBe("large");
  });

  test("ties on efficiency, score, and token cost keep input order", () => {
    const strategy = scorePerToken();
    const result = strategy(
      [
        { content: "first", score: 1 },
        { content: "second", score: 1 },
      ],
      {
        budget: Infinity,
        estimateTokens() {
          return 10;
        },
      },
    );

    expect(result.included[0]!.content).toBe("first");
    expect(result.included[1]!.content).toBe("second");
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

  test('{ type: "quota_by_group" } returns a function', () => {
    const fn = resolveStrategy({
      type: "quota_by_group",
      options: {
        groupBy: "metadata.group",
        quotas: { a: 0.5 },
      },
    });
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

describe("quotaByGroup", () => {
  test("includes at least one chunk per quota group when budget allows", () => {
    const chunks: Chunk[] = [
      { content: "a".repeat(120), score: 0.99, metadata: { group: "A" } },
      { content: "b".repeat(120), score: 0.95, metadata: { group: "A" } },
      { content: "c".repeat(120), score: 0.8, metadata: { group: "B" } },
    ];
    const perChunk = estimateTokens(chunks[0]!.content);
    const strategy = quotaByGroup({
      groupBy: "metadata.group",
      quotas: { A: 0.5, B: 0.5 },
    });

    const result = strategy(chunks, ctx(perChunk * 2));

    expect(result.included).toHaveLength(2);
    const includedGroups = result.included.map((chunk) => chunk.metadata?.group);
    expect(includedGroups).toContain("A");
    expect(includedGroups).toContain("B");
  });

  test("falls back to default group for missing metadata", () => {
    const strategy = quotaByGroup({
      groupBy: "metadata.group",
      quotas: { ungrouped: 1 },
      defaultGroup: "ungrouped",
    });

    const chunks: Chunk[] = [
      { content: "x".repeat(10), score: 0.9 },
      { content: "y".repeat(10), score: 0.8, metadata: {} },
    ];

    const result = strategy(chunks, ctx(Infinity));
    expect(result.included).toHaveLength(2);
  });

  test("throws when quota ratios sum above 1", () => {
    expect(() =>
      quotaByGroup({
        groupBy: "metadata.group",
        quotas: { A: 0.7, B: 0.4 },
      }),
    ).toThrow("quota_by_group: sum of quota ratios must be <= 1.");
  });

  test("throws on invalid quota value", () => {
    expect(() =>
      quotaByGroup({
        groupBy: "metadata.group",
        quotas: { A: -0.1 },
      }),
    ).toThrow('quota_by_group: quota for group "A" must be a finite ratio between 0 and 1.');
  });

  test("throws when groupBy metadata field is empty", () => {
    expect(() =>
      quotaByGroup({
        groupBy: "metadata.",
        quotas: { A: 1 },
      }),
    ).toThrow('quota_by_group: groupBy must use non-empty "metadata.<field>".');
  });
});
