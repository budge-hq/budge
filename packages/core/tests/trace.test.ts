import { describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

describe("trace", () => {
  test("emits trace to the result and onTrace callback", async () => {
    const onTrace = vi.fn();
    const budge = createBudge({ onTrace });

    const encounterSource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve({ input }) {
          return {
            id: input.encounterId,
            status: "ready" as const,
          };
        },
      },
    );

    const window = budge.window({
      id: "trace-window",
      maxTokens: Infinity,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose({ input, use }) {
        const encounter = await use(encounterSource, { encounterId: input.encounterId });

        return {
          system: `Status: ${encounter.status}`,
          prompt: `Encounter:\n${encounter}`,
        };
      },
    });

    const result = await window.resolve({
      input: {
        encounterId: "enc_123",
      },
    });

    expect(onTrace).toHaveBeenCalledTimes(1);
    expect(onTrace).toHaveBeenCalledWith(result.trace);
    expect(result.trace.version).toBe(1);
    expect(result.trace.sources[0]?.sourceId).toBeTruthy();
    expect(result.trace.prompt.systemTokens).toBeGreaterThan(0);
  });

  test("observer hook failures do not corrupt a successful resolution", async () => {
    const onTrace = vi.fn(() => {
      throw new Error("observer failed");
    });
    const budge = createBudge({ onTrace });

    const source = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve({ input }) {
          return {
            id: input.encounterId,
            status: "ready" as const,
          };
        },
      },
    );

    const window = budge.window({
      id: "trace-success-window",
      maxTokens: Infinity,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose({ input, use }) {
        const encounter = await use(source, { encounterId: input.encounterId });

        return {
          prompt: `Encounter:\n${encounter}`,
        };
      },
    });

    const result = await window.resolve({
      input: {
        encounterId: "enc_123",
      },
    });

    expect(onTrace).toHaveBeenCalledTimes(1);
    expect(result.prompt).toContain("enc_123");
  });

  test("observer hook failures do not replace the original resolution error", async () => {
    const onTrace = vi.fn(() => {
      throw new Error("observer failed");
    });
    const budge = createBudge({ onTrace });

    const failingSource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve() {
          throw new Error("source failed");
        },
      },
    );

    const window = budge.window({
      id: "trace-error-window",
      maxTokens: Infinity,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose({ input, use }) {
        await use(failingSource, { encounterId: input.encounterId });

        return {
          prompt: "unreachable",
        };
      },
    });

    await expect(
      window.resolve({
        input: {
          encounterId: "enc_123",
        },
      }),
    ).rejects.toThrow("source failed");
    expect(onTrace).toHaveBeenCalledTimes(1);
  });

  test("plain compose errors get a trace attached and are emitted to onTrace", async () => {
    const onTrace = vi.fn();
    const budge = createBudge({ onTrace });

    const window = budge.window({
      id: "compose-error-window",
      maxTokens: Infinity,
      input: z.object({
        encounterId: z.string(),
      }),
      async compose() {
        throw new Error("compose failed");
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
      expect(error).toBeInstanceOf(Error);
      expect((error as { message: string }).message).toBe("compose failed");
      expect((error as { trace?: unknown }).trace).toBeTruthy();
    }

    expect(onTrace).toHaveBeenCalledTimes(1);
  });
});
