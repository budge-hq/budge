import { describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createPolo, registerSources, type InferContext } from "../src/index.ts";

const polo = createPolo();

describe("integration", () => {
  test("full workflow: input + source + derive + exclude + chunks + trace", async () => {
    const inputSchema = z.object({
      accountId: z.string(),
      transcript: z.string(),
    });
    const accountSourceInputSchema = z.object({
      accountId: z.string(),
    });
    const transcriptSourceInputSchema = z.object({
      transcript: z.string(),
    });
    const accountResult = {
      plan: "enterprise" as const,
      tier: "priority" as const,
    };
    const priorNoteResult = {
      text: "previous note",
    };
    type Account = typeof accountResult;

    const mockDb = {
      account: vi.fn(async (_accountId: string) => accountResult),
      priorNote: vi.fn(async (_plan: Account["plan"]) => priorNoteResult),
    };

    const mockVector = {
      search: vi.fn().mockResolvedValue([
        { pageContent: "guideline A ".repeat(5), score: 0.91 },
        { pageContent: "guideline B ".repeat(5), score: 0.87 },
        { pageContent: "guideline C ".repeat(200), score: 0.42 },
      ] as Array<{ pageContent: string; score: number }>),
    };

    const accountSourceSet = polo.sourceSet(({ source }) => {
      const account = source(accountSourceInputSchema, {
        tags: ["internal"],
        async resolve({ input }) {
          return mockDb.account(input.accountId);
        },
      });

      const priorNote = source(
        accountSourceInputSchema,
        { account },
        {
          async resolve({ account: acc }) {
            return mockDb.priorNote(acc.plan);
          },
        },
      );

      const sensitiveData = source(accountSourceInputSchema, {
        tags: ["phi"],
        async resolve() {
          return { secret: "should be excluded" };
        },
      });

      return {
        account,
        priorNote,
        sensitiveData,
      };
    });

    const guidelineSourceSet = polo.sourceSet(({ source }) => {
      const guidelines = source.rag(transcriptSourceInputSchema, {
        tags: ["internal"],
        async resolve({ input }) {
          return mockVector.search(input.transcript) as Promise<
            Array<{ pageContent: string; score: number }>
          >;
        },
        normalize(item) {
          return {
            content: item.pageContent,
            score: item.score,
          };
        },
      });

      return { guidelines };
    });

    const sourceRegistry = registerSources(accountSourceSet, guidelineSourceSet);

    const run = polo.window({
      input: inputSchema,
      id: "e2e_test",
      sources: {
        transcript: polo.input("transcript", { tags: ["restricted"] }),
        account: sourceRegistry.account,
        priorNote: sourceRegistry.priorNote,
        guidelines: sourceRegistry.guidelines,
        sensitiveData: sourceRegistry.sensitiveData,
      },
      derive: (ctx) => ({
        isEnterprise: ctx.account.plan === "enterprise",
        replyStyle: ctx.account.tier === "priority" ? "concise" : "standard",
        hasPriorNote: !!ctx.priorNote,
      }),
      policies: {
        require: ["transcript", "account"],
        prefer: ["priorNote", "guidelines"],
        exclude: [
          () => ({
            source: "sensitiveData",
            reason: "sensitive data excluded from this task",
          }),
        ],
        budget: 500,
      },
    });

    const { context, traces } = await run({
      accountId: "acc_123",
      transcript: "patient says they feel better",
    });
    type TaskContext = InferContext<typeof run>;
    const typedContext: TaskContext = context;

    expect(typedContext.transcript).toBe("patient says they feel better");
    expect(typedContext.account).toEqual({ plan: "enterprise", tier: "priority" });
    expect(typedContext.priorNote).toEqual({ text: "previous note" });

    expect("sensitiveData" in context).toBe(false);

    expect(context.isEnterprise).toBe(true);
    expect(context.replyStyle).toBe("concise");
    expect(context.hasPriorNote).toBe(true);

    const guidelines = context.guidelines ?? [];
    expect(Array.isArray(guidelines)).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);

    expect(traces.windowId).toBe("e2e_test");
    expect(traces.runId).toBeTruthy();
    expect(traces.sources.length).toBeGreaterThan(0);
    expect(traces.budget.max).toBe(500);

    const excl = traces.policies.find((p) => p.action === "excluded");
    expect(excl?.source).toBe("sensitiveData");

    expect(JSON.stringify(traces)).not.toContain("should be excluded");
  });
});
