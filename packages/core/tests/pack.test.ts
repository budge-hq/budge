import { describe, expect, test } from "vite-plus/test";
import { estimateTokens, normalizeBudget, packChunks, serialize } from "../src/pack.ts";
import { greedyScore, scorePerToken } from "../src/strategies.ts";
import type { RagItems } from "../src/types.ts";

describe("serialize", () => {
  test("strings pass through unchanged", () => {
    expect(serialize("hello world")).toBe("hello world");
  });

  test("strings with label are prefixed", () => {
    expect(serialize("hello", "msg")).toBe("msg:\nhello");
  });

  test("null returns empty string", () => {
    expect(serialize(null)).toBe("");
  });

  test("undefined returns empty string", () => {
    expect(serialize(undefined)).toBe("");
  });

  test("objects are TOON-encoded", () => {
    const result = serialize({ name: "Alice", plan: "enterprise" });
    expect(result).not.toBe('{"name":"Alice","plan":"enterprise"}');
    expect(result.length).toBeLessThan(
      JSON.stringify({ name: "Alice", plan: "enterprise" }).length,
    );
  });

  test("objects with label add section header", () => {
    const result = serialize({ id: "1" }, "account");
    expect(result.startsWith("account:\n")).toBe(true);
  });

  test("arrays of uniform objects encode compactly", () => {
    const rows = [
      { id: "t1", subject: "Auth issue", score: 0.9 },
      { id: "t2", subject: "Billing", score: 0.8 },
    ];
    const toon = serialize(rows);
    const json = JSON.stringify(rows);
    expect(toon.length).toBeLessThan(json.length);
  });

  test("arrays with label add section header", () => {
    const result = serialize([{ id: "1" }], "tickets");
    expect(result.startsWith("tickets:\n")).toBe(true);
  });

  test("numbers and booleans are encoded", () => {
    expect(serialize(42)).not.toBe("");
    expect(serialize(true)).not.toBe("");
  });
});

describe("normalizeBudget", () => {
  test("undefined returns Infinity budget with greedy_score", () => {
    const result = normalizeBudget(undefined);
    expect(result.maxTokens).toBe(Infinity);
    expect(result.strategyFn).toBe(greedyScore);
    expect(result.strategyName).toBe("greedy_score");
  });

  test("number returns that number with greedy_score", () => {
    const result = normalizeBudget(100);
    expect(result.maxTokens).toBe(100);
    expect(result.strategyFn).toBe(greedyScore);
    expect(result.strategyName).toBe("greedy_score");
  });

  test("BudgetConfig with score_per_token strategy", () => {
    const result = normalizeBudget({ maxTokens: 200, strategy: { type: "score_per_token" } });
    expect(result.maxTokens).toBe(200);
    expect(result.strategyName).toBe("score_per_token");
    expect(result.strategyFn).not.toBe(greedyScore);
  });

  test("BudgetConfig with custom function", () => {
    const custom = () => ({ included: [], records: [], tokensUsed: 0 });
    const result = normalizeBudget({ maxTokens: 50, strategy: custom });
    expect(result.maxTokens).toBe(50);
    expect(result.strategyFn).toBe(custom);
    expect(result.strategyName).toBe("custom");
  });

  test("BudgetConfig with no strategy defaults to greedy_score", () => {
    const result = normalizeBudget({ maxTokens: 300 });
    expect(result.strategyFn).toBe(greedyScore);
    expect(result.strategyName).toBe("greedy_score");
  });
});

describe("packChunks", () => {
  const makeChunks = (items: Array<{ content: string; score?: number }>): RagItems => ({
    _type: "rag",
    items,
  });

  test("with explicit greedyScore matches default behavior", () => {
    const chunks = makeChunks([
      { content: "hello", score: 0.9 },
      { content: "world", score: 0.5 },
    ]);
    const defaultResult = packChunks(chunks, Infinity);
    const explicitResult = packChunks(chunks, Infinity, greedyScore);
    expect(defaultResult.included.length).toBe(explicitResult.included.length);
    expect(defaultResult.tokensUsed).toBe(explicitResult.tokensUsed);
  });

  test("with scorePerToken prefers efficient chunks under tight budget", () => {
    const big = "x".repeat(200);
    const small1 = "a".repeat(30);
    const small2 = "b".repeat(30);

    const budget = estimateTokens(big) + 1;
    const chunks = makeChunks([
      { content: big, score: 0.9 },
      { content: small1, score: 0.6 },
      { content: small2, score: 0.5 },
    ]);

    const greedy = packChunks(chunks, budget, greedyScore);
    const efficient = packChunks(chunks, budget, scorePerToken());

    expect(greedy.included).toHaveLength(1);
    expect(greedy.included[0]!.score).toBe(0.9);

    expect(efficient.included).toHaveLength(2);
    expect(efficient.included[0]!.score).toBe(0.6);
    expect(efficient.included[1]!.score).toBe(0.5);
  });
});
