import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo } from "../src/index.ts";
import { buildTrace } from "../src/trace.ts";

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("trace", () => {
  test("trace contains source timing records", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_trace_sources",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ id: "acc_1" }),
            tags: ["internal"],
          }),
        })),
      },
    });

    const { traces } = await run({});
    const sourceRecord = traces.sources.find((s) => s.key === "account");
    expect(sourceRecord).toBeDefined();
    expect(sourceRecord?.tags).toEqual(["internal"]);
    expect(typeof sourceRecord?.durationMs).toBe("number");
  });

  test("trace contains budget usage", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_trace_budget",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          data: source(emptyInputSchema, {
            resolve: async () => ({ value: "hello" }),
          }),
        })),
      },
      policies: { budget: 10_000 },
    });

    const { traces } = await run({});
    expect(traces.budget.max).toBe(10_000);
    expect(traces.budget.used).toBeGreaterThanOrEqual(0);
  });

  test("trace contains derived values", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_trace_derived",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ plan: "enterprise" as const }),
          }),
        })),
      },
      derive: (ctx) => ({
        isEnterprise: ctx.account.plan === "enterprise",
      }),
    });

    const { traces } = await run({});
    expect(traces.derived["isEnterprise"]).toBe(true);
  });

  test("each run gets a unique runId", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_run_id",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          data: source(emptyInputSchema, {
            resolve: async () => "x",
          }),
        })),
      },
    });

    const [r1, r2] = await Promise.all([run({}), run({})]);

    expect(r1.traces.runId).not.toBe(r2.traces.runId);
  });

  test("trace does not contain raw resolved data", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_trace_no_data",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          secret: source(emptyInputSchema, {
            resolve: async () => ({ ssn: "123-45-6789" }),
            tags: ["phi"],
          }),
        })),
      },
    });

    const { traces } = await run({});
    const raw = JSON.stringify(traces);
    expect(raw).not.toContain("123-45-6789");
  });

  test("buildTrace falls back to empty chunks when chunkRecords are missing", () => {
    const now = new Date();
    const traces = buildTrace({
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

    const docs = traces.sources.find((source) => source.key === "docs");
    expect(docs?.type).toBe("rag");
    if (docs?.type === "rag") {
      expect(docs.items).toEqual([]);
    }
  });
});
