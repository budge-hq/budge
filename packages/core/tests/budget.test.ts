import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { BudgetExceededError, createBudge } from "../src/index.ts";

describe("maxTokens", () => {
  test("throws a typed error with trace when the final prompt exceeds budget", async () => {
    const budge = createBudge();

    const noteSource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve({ input }) {
          return `${input.encounterId} `.repeat(200);
        },
      },
    );

    const window = budge.window({
      id: "budget-window",
      maxTokens: 20,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose({ input, use }) {
        const note = await use(noteSource, { encounterId: input.encounterId });

        return {
          prompt: `Note:\n${note}`,
        };
      },
    });

    try {
      await window.resolve({
        input: {
          encounterId: "enc_123",
        },
      });
      throw new Error("Expected window.resolve() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const budgetError = error as BudgetExceededError;
      expect(budgetError.trace?.budget.exceeded).toBe(true);
      expect(budgetError.trace?.prompt.totalTokens).toBeGreaterThan(20);
    }
  });
});
