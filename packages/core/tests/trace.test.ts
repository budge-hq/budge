import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo } from "../src/index.ts";
import { buildTrace } from "../src/trace.ts";

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("trace", () => {
  test("trace contains source timing records", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_sources",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ id: "acc_1" }),
          tags: ["internal"],
        }),
      },
    });

    const { trace } = await polo.resolve(task, {});
    const sourceRecord = trace.sources.find((s) => s.key === "account");
    expect(sourceRecord).toBeDefined();
    expect(sourceRecord?.tags).toEqual(["internal"]);
    expect(typeof sourceRecord?.durationMs).toBe("number");
  });

  test("trace contains budget usage", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_budget",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => ({ value: "hello" }),
        }),
      },
      policies: { budget: 10_000 },
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.budget.max).toBe(10_000);
    expect(trace.budget.used).toBeGreaterThanOrEqual(0);
  });

  test("trace contains derived values", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_derived",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ plan: "enterprise" as const }),
        }),
      },
      derive: ({ context }) => ({
        isEnterprise: context.account.plan === "enterprise",
      }),
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.derived["isEnterprise"]).toBe(true);
  });

  test("each run gets a unique runId", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_run_id",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => "x",
        }),
      },
    });

    const [r1, r2] = await Promise.all([polo.resolve(task, {}), polo.resolve(task, {})]);

    expect(r1.trace.runId).not.toBe(r2.trace.runId);
  });

  test("trace does not contain raw resolved data", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_no_data",
      sources: {
        secret: polo.source(emptyInputSchema, {
          resolve: async () => ({ ssn: "123-45-6789" }),
          tags: ["phi"],
        }),
      },
    });

    const { trace } = await polo.resolve(task, {});
    const raw = JSON.stringify(trace);
    expect(raw).not.toContain("123-45-6789");
  });

  test("buildTrace falls back to empty chunks when chunkRecords are missing", () => {
    const now = new Date();
    const trace = buildTrace({
      taskId: "test_trace_chunk_fallback",
      startedAt: now,
      completedAt: now,
      sourceTimings: [
        {
          key: "docs",
          type: "chunks",
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
    expect(docs?.type).toBe("chunks");
    if (docs?.type === "chunks") {
      expect(docs.chunks).toEqual([]);
    }
  });
});
