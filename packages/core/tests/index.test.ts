import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

describe("compose + resolve", () => {
  test("resolves reusable sources inside compose and returns trace", async () => {
    const budge = createBudge();

    const accountSource = budge.source.value(
      z.object({
        accountId: z.string(),
      }),
      {
        tags: ["internal"],
        async resolve({ input }) {
          return {
            id: input.accountId,
            name: "Acme",
            plan: "enterprise" as const,
          };
        },
      },
    );

    const priorNoteSource = budge.source.value(
      z.object({
        encounter: z.object({
          id: z.string(),
          name: z.string(),
          plan: z.string(),
        }),
      }),
      {
        async resolve({ input }) {
          return `Prior note for ${input.encounter.name}`;
        },
      },
    );

    const window = budge.window({
      id: "support-note",
      maxTokens: Infinity,
      input: z.object({
        accountId: z.string(),
      }),
      async compose({ input, use }) {
        const account = await use(accountSource, { accountId: input.accountId });
        const priorNote = await use(priorNoteSource, { encounter: account });

        const accountName: string = account.name;
        const noteText: string = priorNote;

        return {
          system: `You are helping ${accountName}.`,
          prompt: `Account:\n${account}\n\nPrior note:\n${noteText}`,
        };
      },
    });

    const result = await window.resolve({
      input: {
        accountId: "acc_123",
      },
    });

    expect(result.system).toContain("Acme");
    expect(result.prompt).toContain("Prior note for Acme");
    expect(result.prompt).not.toContain("[object Object]");
    expect(result.trace.windowId).toBe("support-note");
    expect(result.trace.sources).toHaveLength(2);
    expect(result.trace.budget.max).toBeNull();
    expect(result.trace.prompt.totalTokens).toBeGreaterThan(0);
  });
});
