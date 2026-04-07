import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

describe("sources", () => {
  test("validates source input schemas before calling resolve", async () => {
    const budge = createBudge();

    const source = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve({ input }) {
          return input.encounterId;
        },
      },
    );

    await expect(
      source.resolve({
        encounterId: 42,
      } as unknown as { encounterId: string }),
    ).rejects.toThrow("Source input validation failed");
  });

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
      input: z.object({
        encounterId: z.string(),
      }),
      sources: () => ({
        invalidSource,
      }),
    });

    await expect(
      window.resolve({
        input: {
          encounterId: "enc_123",
        },
      }),
    ).rejects.toThrow("Source output validation failed");
  });

  test("applies output schema transforms to resolved source values", async () => {
    const budge = createBudge();

    const transformedSource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        output: z
          .object({
            text: z.string(),
            internal: z.string(),
          })
          .transform(({ text }) => ({ text })),
        async resolve() {
          return {
            text: "hello",
            internal: "secret",
          };
        },
      },
    );

    const window = budge.window({
      id: "transformed-source",
      input: z.object({
        encounterId: z.string(),
      }),
      sources: () => ({
        transformedSource,
      }),
    });

    const result = await window.resolve({
      input: {
        encounterId: "enc_123",
      },
    });

    expect(result.context.transformedSource).toEqual({ text: "hello" });
  });

  test("passes through window input with fromInput", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "from-input-window",
      input: z.object({
        encounterId: z.string(),
      }),
      sources: ({ source }) => ({
        encounterId: source.fromInput("encounterId", { tags: ["restricted"] }),
      }),
    });

    const result = await window.resolve({
      input: {
        encounterId: "enc_123",
      },
    });

    expect(result.context.encounterId).toBe("enc_123");
    expect(result.traces.sources[0]?.kind).toBe("input");
  });
});
