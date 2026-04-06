import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { RequiredSourceValueError, createBudge } from "../src/index.ts";

describe("sources", () => {
  test("validates source output schemas", async () => {
    const budge = createBudge();

    const invalidSource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        output: z.object({
          text: z.string(),
        }),
        async resolve() {
          return { text: 42 } as unknown as { text: string };
        },
      },
    );

    const window = budge.window({
      id: "invalid-source",
      maxTokens: Infinity,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose({ input, use }) {
        const value = await use(invalidSource, { encounterId: input.encounterId });

        return {
          prompt: String(value),
        };
      },
    });

    await expect(
      window.resolve({
        input: {
          encounterId: "enc_123",
        },
      }),
    ).rejects.toThrow("Source output validation failed");
  });

  test("treats use() as required and throws when a source resolves empty", async () => {
    const budge = createBudge();

    const emptySource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve() {
          return undefined as string | undefined;
        },
      },
    );

    const window = budge.window({
      id: "required-source",
      maxTokens: Infinity,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose({ input, use }) {
        const note = await use(emptySource, { encounterId: input.encounterId });

        return {
          prompt: note,
        };
      },
    });

    await expect(
      window.resolve({
        input: {
          encounterId: "enc_123",
        },
      }),
    ).rejects.toBeInstanceOf(RequiredSourceValueError);
  });
});
