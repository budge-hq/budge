import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";
import { createRagItems } from "../src/rag.ts";
import { estimateTokens } from "../src/pack.ts";
import type { AnyResolverSource, BudgetStrategyFn } from "../src/types.ts";

const budge = createBudge();
const emptyInputSchema = z.object({});

describe("budge.source.rag", () => {
  test("packs chunks within budget", async () => {
    const items = [
      { content: "a".repeat(100), score: 0.9 },
      { content: "b".repeat(100), score: 0.8 },
      { content: "c".repeat(100), score: 0.7 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_chunks_budget",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          guidelines: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize(item) {
              return {
                content: item.content,
                score: item.score,
              };
            },
          }),
        })),
      },
      policies: { budget: 40 },
    });

    const { context, trace } = await run({});
    const chunks = context.guidelines as Array<{ content: string }>;
    expect(chunks.length).toBe(2);

    const chunkSource_ = trace.sources.find((s) => s.key === "guidelines");
    expect(chunkSource_?.type).toBe("rag");
    const dropped =
      chunkSource_?.type === "rag" ? chunkSource_.items.filter((c) => !c.included) : [];
    expect(dropped?.length).toBeGreaterThan(0);
    expect(dropped?.[0]?.reason).toBe("over_budget");
  });

  test("includes all chunks when budget is not set", async () => {
    const items = [
      { content: "x".repeat(10), score: 0.9 },
      { content: "y".repeat(10), score: 0.8 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_chunks_no_budget",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize(item) {
              return {
                content: item.content,
                score: item.score,
              };
            },
          }),
        })),
      },
    });

    const { context } = await run({});
    const chunks = context.docs as Array<{ content: string }>;
    expect(chunks.length).toBe(2);
  });

  test("required chunk sources are never trimmed in non-render mode", async () => {
    const items = [
      { content: "high ".repeat(30), score: 0.9 },
      { content: "mid ".repeat(30), score: 0.5 },
      { content: "low ".repeat(30), score: 0.1 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_required_chunks_non_template",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize(item) {
              return {
                content: item.content,
                score: item.score,
              };
            },
          }),
        })),
      },
      policies: {
        require: ["docs"],
        budget: 1,
      },
    });

    const { context, trace } = await run({});
    expect(context.docs).toHaveLength(3);

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("rag");
    if (docsRecord?.type === "rag") {
      expect(docsRecord.items).toHaveLength(3);
      expect(docsRecord.items.every((chunk) => chunk.included)).toBe(true);
    }

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy).toBeUndefined();
  });

  test("non-required chunk source gets dropped policy when all chunks are over budget", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_chunks_full_drop_policy_record",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          guidelines: source.rag(emptyInputSchema, {
            async resolve() {
              return [
                { content: "long chunk that will be dropped ".repeat(20), score: 0.9 },
                { content: "another long chunk that will be dropped ".repeat(20), score: 0.8 },
              ];
            },
          }),
        })),
      },
      policies: { budget: 1 },
    });

    const { context, trace } = await run({});
    expect("guidelines" in context).toBe(false);

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "guidelines" && policy.action === "dropped",
    );
    expect(droppedPolicy?.reason).toBe("over_budget");

    const guidelinesRecord = trace.sources.find((source) => source.key === "guidelines");
    expect(guidelinesRecord?.type).toBe("rag");
    if (guidelinesRecord?.type === "rag") {
      expect(guidelinesRecord.items.every((chunk) => chunk.included === false)).toBe(true);
      expect(guidelinesRecord.items.every((chunk) => chunk.reason === "over_budget")).toBe(true);
    }
  });

  test("empty chunk source is not marked dropped", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_empty_chunks_not_dropped",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return [];
            },
          }),
        })),
      },
      policies: { budget: 1 },
    });

    const { context, trace } = await run({});
    expect(context.docs).toEqual([]);

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy).toBeUndefined();
  });

  test("chunks are sorted by score descending", async () => {
    const items = [
      { content: "low", score: 0.3 },
      { content: "high", score: 0.9 },
      { content: "mid", score: 0.6 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_chunks_order",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize(item) {
              return {
                content: item.content,
                score: item.score,
              };
            },
          }),
        })),
      },
    });

    const { context } = await run({});
    const chunks = context.docs as Array<{ content: string; score?: number }>;
    expect(chunks[0]?.content).toBe("high");
    expect(chunks[1]?.content).toBe("mid");
    expect(chunks[2]?.content).toBe("low");
  });

  test("throws when normalize returns invalid chunks", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_chunks_invalid_normalize",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return [{ value: "not-content" }];
            },
            normalize(item) {
              return {
                content: (item as { missing?: string }).missing as string,
              };
            },
          }),
        })),
      },
    });

    await expect(run({})).rejects.toThrow(
      /normalize\(\) must return Chunk objects with string content/,
    );
  });

  test("createRagItems rejects invalid non-normalized items", async () => {
    await expect(
      createRagItems(Promise.resolve([{ text: "not a chunk" }] as never)),
    ).rejects.toThrow(/requires either Chunk\[] input or a normalize function/);
  });

  test("dependent chunk sources also reject invalid normalize output", async () => {
    const sharedSourceSet = budge.sourceSet(({ source }) => {
      const account = source.value(emptyInputSchema, {
        async resolve() {
          return { id: "acc_1" };
        },
      });

      const docs = source.rag(
        emptyInputSchema,
        { account },
        {
          async resolve() {
            return [{ value: "not-content" }];
          },
          normalize(item) {
            return {
              content: (item as { missing?: string }).missing as string,
            };
          },
        },
      );

      return { account, docs };
    });

    const sourceRegistry = budge.sources(sharedSourceSet);
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_dep_chunks_invalid_normalize",
      sources: {
        account: sourceRegistry.account,
        docs: sourceRegistry.docs,
      },
    });

    await expect(run({})).rejects.toThrow(
      /normalize\(\) must return Chunk objects with string content/,
    );
  });

  test("dependent resolvers receive rag dependencies as chunk arrays", async () => {
    const sharedSourceSet = budge.sourceSet(({ source }) => {
      const docs = source.rag(emptyInputSchema, {
        async resolve() {
          return [{ content: "alpha" }, { content: "beta" }];
        },
      });

      const summary = source.value(
        emptyInputSchema,
        { docs },
        {
          async resolve({ docs: chunks }) {
            return chunks.map((chunk) => chunk.content).join(",");
          },
        },
      );

      return { docs, summary };
    });

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_rag_dependency_shape",
      sources: {
        docs: sharedSourceSet.docs,
        summary: sharedSourceSet.summary,
      },
    });

    const { context } = await run({});
    expect(context.summary).toBe("alpha,beta");
  });

  test("throws when a chunk source resolves malformed chunk envelopes", async () => {
    const ragLikeSet = budge.sourceSet(({ source }) => ({
      docs: source.value(emptyInputSchema, {
        async resolve() {
          return {
            _type: "rag",
            items: [{ content: undefined }],
          };
        },
      }),
    }));
    (ragLikeSet.docs as AnyResolverSource)._sourceKind = "rag";

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_chunks_malformed_envelope",
      sources: {
        docs: ragLikeSet.docs,
      },
    });

    await expect(run({})).rejects.toThrow(/resolved malformed rag items/);
  });

  test("BudgetConfig with score_per_token strategy changes packing", async () => {
    const items = [
      { content: "x".repeat(200), score: 0.9 },
      { content: "a".repeat(30), score: 0.6 },
      { content: "b".repeat(30), score: 0.5 },
    ];

    const makeTask = (
      budget:
        | number
        | { maxTokens: number; strategy: { type: "greedy_score" | "score_per_token" } },
    ) =>
      budge.window({
        input: emptyInputSchema,
        id: `test_strategy_${typeof budget === "number" ? "number" : budget.strategy.type}`,
        sources: {
          ...budge.sourceSet(({ source }) => ({
            docs: source.rag(emptyInputSchema, {
              async resolve() {
                return items;
              },
              normalize(item) {
                return { content: item.content, score: item.score };
              },
            }),
          })),
        },
        policies: { budget },
      });

    const bigTokens = estimateTokens(items[0]!.content);
    const budget = bigTokens + 1;

    const greedyResult = await makeTask(budget)({});
    const efficientResult = await makeTask({
      maxTokens: budget,
      strategy: { type: "score_per_token" },
    })({});

    const greedyChunks = greedyResult.context.docs as Array<{ content: string }>;
    const efficientChunks = efficientResult.context.docs as Array<{ content: string }>;

    expect(greedyChunks).toHaveLength(1);
    expect(greedyChunks[0]!.content).toBe(items[0]!.content);

    expect(efficientChunks).toHaveLength(2);
    expect(efficientChunks[0]!.content).toBe(items[1]!.content);
    expect(efficientChunks[1]!.content).toBe(items[2]!.content);
  });

  test("custom strategy function is invoked", async () => {
    let strategyCalled = false;
    const customStrategy: BudgetStrategyFn = (chunks, ctx) => {
      strategyCalled = true;
      const first = chunks[0]!;
      const tokens = ctx.estimateTokens(first.content);
      return {
        included: [first],
        records: chunks.map((c, i) => ({
          content: c.content,
          score: c.score,
          included: i === 0,
          ...(i > 0 ? { reason: "custom_filter" } : {}),
        })),
        tokensUsed: tokens,
      };
    };

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_custom_strategy",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return [
                { content: "first", score: 0.9 },
                { content: "second", score: 0.8 },
              ];
            },
          }),
        })),
      },
      policies: { budget: { maxTokens: 1000, strategy: customStrategy } },
    });

    const { context } = await run({});
    expect(strategyCalled).toBe(true);
    const chunks = context.docs as Array<{ content: string }>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("first");
  });

  test("trace includes strategy name and candidate/selected counts", async () => {
    const items = [
      { content: "a".repeat(100), score: 0.9 },
      { content: "b".repeat(100), score: 0.8 },
      { content: "c".repeat(100), score: 0.7 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_trace_strategy",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize(item) {
              return { content: item.content, score: item.score };
            },
          }),
        })),
      },
      policies: { budget: { maxTokens: 40, strategy: { type: "score_per_token" } } },
    });

    const { trace } = await run({});
    expect(trace.budget.strategy).toBe("score_per_token");
    expect(trace.budget.candidates).toBe(3);
    expect(typeof trace.budget.selected).toBe("number");
  });

  test("backward compat: budget as number still populates trace strategy", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_trace_compat",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return [{ content: "hello", score: 1 }];
            },
          }),
        })),
      },
      policies: { budget: 100 },
    });

    const { trace } = await run({});
    expect(trace.budget.strategy).toBe("greedy_score");
    expect(trace.budget.candidates).toBe(1);
    expect(trace.budget.selected).toBe(1);
  });

  test("non-chunk sources over budget produce dropped policy records", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_non_chunk_over_budget_drop",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          requiredText: source.value(emptyInputSchema, {
            resolve: async () => "keep me",
          }),
          extraText: source.value(emptyInputSchema, {
            resolve: async () => "x".repeat(2_000),
          }),
        })),
      },
      policies: {
        require: ["requiredText"],
        budget: 10,
      },
    });

    const { context, trace } = await run({});
    expect(context.requiredText).toBe("keep me");
    expect("extraText" in context).toBe(false);

    const dropped = trace.policies.find(
      (policy) => policy.source === "extraText" && policy.action === "dropped",
    );
    expect(dropped?.reason).toBe("over_budget");
  });
});
