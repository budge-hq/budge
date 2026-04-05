import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";
import { buildTrace } from "../src/trace.ts";

const budge = createBudge();
const emptyInputSchema = z.object({});

describe("trace", () => {
  test("trace contains source timing records", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_trace_sources",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ id: "acc_1" }),
            tags: ["internal"],
          }),
        })),
      },
    });

    const { trace } = await run({});
    const sourceRecord = trace.sources.find((s) => s.key === "account");
    expect(sourceRecord).toBeDefined();
    expect(sourceRecord?.tags).toEqual(["internal"]);
    expect(typeof sourceRecord?.durationMs).toBe("number");
  });

  test("trace contains budget usage", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_trace_budget",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          data: source.value(emptyInputSchema, {
            resolve: async () => ({ value: "hello" }),
          }),
        })),
      },
      policies: { budget: 10_000 },
    });

    const { trace } = await run({});
    expect(trace.budget.max).toBe(10_000);
    expect(trace.budget.used).toBeGreaterThanOrEqual(0);
  });

  test("trace contains derived values", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_trace_derived",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ plan: "enterprise" as const }),
          }),
        })),
      },
      derive: (ctx) => ({
        isEnterprise: ctx.account.plan === "enterprise",
      }),
    });

    const { trace } = await run({});
    expect(trace.derived["isEnterprise"]).toBe(true);
  });

  test("each run gets a unique runId", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_run_id",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          data: source.value(emptyInputSchema, {
            resolve: async () => "x",
          }),
        })),
      },
    });

    const [r1, r2] = await Promise.all([run({}), run({})]);

    expect(r1.trace.runId).not.toBe(r2.trace.runId);
  });

  test("trace does not contain raw resolved data", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_trace_no_data",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          secret: source.value(emptyInputSchema, {
            resolve: async () => ({ ssn: "123-45-6789" }),
            tags: ["phi"],
          }),
        })),
      },
    });

    const { trace } = await run({});
    const raw = JSON.stringify(trace);
    expect(raw).not.toContain("123-45-6789");
  });

  test("buildTrace falls back to empty chunks when chunkRecords are missing", () => {
    const now = new Date();
    const trace = buildTrace({
      windowId: "test_trace_chunk_fallback",
      startedAt: now,
      completedAt: now,
      sourceTimings: [
        {
          key: "docs",
          type: "rag",
          tags: [],
          resolvedAt: now,
          durationMs: 0,
        },
      ],
      policyRecords: [],
      derived: {},
      budgetMax: 0,
      budgetUsed: 0,
    });

    const docs = trace.sources.find((source) => source.key === "docs");
    expect(docs?.type).toBe("rag");
    if (docs?.type === "rag") {
      expect(docs.items).toEqual([]);
    }
  });
});
