import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

describe("rag sources", () => {
  test("unwraps rag results to chunk arrays and interpolates them safely", async () => {
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

    const window = budge.window({
      id: "rag-window",
      maxTokens: Infinity,
      input: z.object({
        query: z.string(),
      }),
      async compose({ input, use }) {
        const docs = await use(docsSource, { query: input.query });
        const firstDoc: string = docs[0].content;

        return {
          prompt: `First doc:\n${firstDoc}\n\nAll docs:\n${docs}`,
        };
      },
    });

    const result = await window.resolve({
      input: {
        query: "refund policy",
      },
    });

    expect(result.prompt).toContain("Doc for refund policy");
    expect(result.prompt).not.toContain("[object Object]");
    expect(result.trace.sources).toHaveLength(1);
    expect(result.trace.sources[0]?.kind).toBe("rag");
    expect(result.trace.sources[0]?.itemCount).toBe(2);
  });
});
