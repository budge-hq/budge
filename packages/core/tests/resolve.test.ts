import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { SourceResolutionError, createBudge } from "../src/index.ts";

describe("resolve", () => {
  test("includes the window id when resolve input fails schema validation", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "validated-window",
      input: z.object({
        encounterId: z.string(),
      }),
      sources: ({ source }) => ({
        encounterId: source.fromInput("encounterId"),
      }),
    });

    await expect(
      window.resolve({
        input: {
          encounterId: 42,
        } as unknown as { encounterId: string },
      }),
    ).rejects.toThrow('Input validation failed for context window "validated-window"');
  });

  test("wraps source failures with source context and traces", async () => {
    const budge = createBudge();

    const failingSource = budge.source.value(
      z.object({
        encounterId: z.string(),
      }),
      {
        async resolve() {
          throw new Error("db offline");
        },
      },
    );

    const window = budge.window({
      id: "source-error-window",
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

      const sourceError = error as SourceResolutionError;
      expect(sourceError.message).toContain("db offline");
      expect(sourceError.sourceKey).toBe("failing");
      expect(sourceError.cause).toBeInstanceOf(Error);
      expect((sourceError.cause as Error).message).toBe("db offline");
      expect(sourceError.traces?.windowId).toBe("source-error-window");
      expect(sourceError.traces?.sources).toHaveLength(1);
      expect(sourceError.traces?.sources[0]?.status).toBe("failed");
    }
  });
});
