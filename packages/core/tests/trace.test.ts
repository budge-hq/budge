import { describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { SourceResolutionError, createBudge } from "../src/index.ts";

describe("traces", () => {
  test("emits traces to the result and onTrace callback", async () => {
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
      input: z.object({
        encounterId: z.string(),
      }),
      sources: () => ({
        encounter: encounterSource,
      }),
    });

    const result = await window.resolve({
      input: {
        encounterId: "enc_123",
      },
      sessionId: "sess_123",
      turnIndex: 7,
    });

    expect(onTrace).toHaveBeenCalledTimes(1);
    expect(onTrace).toHaveBeenCalledWith(result.traces);
    expect(result.traces.version).toBe(1);
    expect(result.traces.sessionId).toBe("sess_123");
    expect(result.traces.turnIndex).toBe(7);
    expect(result.traces.sources[0]?.sourceId).toBeTruthy();
    expect(result.traces.sources[0]?.fingerprint).toBe("trace-window:encounter");
    expect(result.traces.sources[0]?.status).toBe("resolved");
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
      input: z.object({
        encounterId: z.string(),
      }),
      sources: () => ({
        encounter: source,
      }),
    });

    const result = await window.resolve({
      input: {
        encounterId: "enc_123",
      },
    });

    expect(onTrace).toHaveBeenCalledTimes(1);
    expect(result.context.encounter.id).toBe("enc_123");
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
      input: z.object({
        encounterId: z.string(),
      }),
      sources: () => ({
        failing: failingSource,
      }),
    });

    try {
      await window.resolve({
        input: {
          encounterId: "enc_123",
        },
      });
      throw new Error("Expected window.resolve() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceResolutionError);
      expect((error as SourceResolutionError).message).toContain("source failed");
    }

    expect(onTrace).toHaveBeenCalledTimes(1);
  });
});
