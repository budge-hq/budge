import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

describe("rag sources", () => {
  test("normalizes rag results into chunks", async () => {
    const budge = createBudge();

    const docsSource = budge.source.rag(
      z.object({
        query: z.string(),
      }),
      {
        normalize(item: { body: string; relevance: number }) {
          return {
            content: item.body,
            score: item.relevance,
          };
        },
        async resolve({ input }) {
          return [
            { body: `Doc for ${input.query}`, relevance: 0.9 },
            { body: "Fallback doc", relevance: 0.5 },
          ];
        },
      },
    );

    await expect(docsSource.resolve({ query: "refund policy" })).resolves.toEqual([
      { content: "Doc for refund policy", score: 0.9 },
      { content: "Fallback doc", score: 0.5 },
    ]);
  });

  test("rejects invalid normalized rag results", async () => {
    const budge = createBudge();

    const docsSource = budge.source.rag(
      z.object({
        query: z.string(),
      }),
      {
        normalize(item: { body: string }) {
          return {
            body: item.body,
          } as unknown as { content: string };
        },
        async resolve() {
          return [{ body: "Not a chunk" }];
        },
      },
    );

    await expect(docsSource.resolve({ query: "refund policy" })).rejects.toThrow(
      "budge.source.rag() normalize() must return Chunk objects with string content.",
    );
  });

  test("resolves rag sources to chunk arrays and interpolates them safely", async () => {
    const budge = createBudge();

    const docsSource = budge.source.rag(
      z.object({
        query: z.string(),
      }),
      {
        async resolve({ input }) {
          return [
            { content: `Doc for ${input.query}`, score: 0.9 },
            { content: "Fallback doc", score: 0.5 },
          ];
        },
      },
    );

    await expect(docsSource.resolve({ query: "refund policy" })).resolves.toEqual([
      { content: "Doc for refund policy", score: 0.9 },
      { content: "Fallback doc", score: 0.5 },
    ]);

    const window = budge.window({
      id: "rag-window",
      input: z.object({
        query: z.string(),
      }),
      sources: () => ({
        docs: docsSource,
      }),
    });

    const result = await window.resolve({
      input: {
        query: "refund policy",
      },
    });

    expect(result.context.docs[0]?.content).toBe("Doc for refund policy");
    expect(result.traces.sources).toHaveLength(1);
    expect(result.traces.sources[0]?.kind).toBe("rag");
    expect(result.traces.sources[0]?.itemCount).toBe(2);
  });
});
