import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo, registerSources } from "../src/index.ts";
import { createChunks } from "../src/chunks.ts";
import type { AnyResolverSource } from "../src/types.ts";

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("polo.source.chunks", () => {
  test("packs chunks within budget", async () => {
    const items = [
      { content: "a".repeat(100), score: 0.9 },
      { content: "b".repeat(100), score: 0.8 },
      { content: "c".repeat(100), score: 0.7 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_chunks_budget",
      sources: {
        guidelines: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize(item) {
            return {
              content: item.content,
              score: item.score,
            };
          },
        }),
      },
      policies: {
        budget: 40,
      },
    });

    const { context, trace } = await polo.resolve(task, {});
    const chunks = context.guidelines as Array<{ content: string }>;
    expect(chunks.length).toBe(2);

    const chunkSource_ = trace.sources.find((s) => s.key === "guidelines");
    expect(chunkSource_?.type).toBe("chunks");
    const dropped =
      chunkSource_?.type === "chunks" ? chunkSource_.chunks.filter((c) => !c.included) : [];
    expect(dropped?.length).toBeGreaterThan(0);
    expect(dropped?.[0]?.reason).toBe("over_budget");
  });

  test("includes all chunks when budget is not set", async () => {
    const items = [
      { content: "x".repeat(10), score: 0.9 },
      { content: "y".repeat(10), score: 0.8 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_chunks_no_budget",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize(item) {
            return {
              content: item.content,
              score: item.score,
            };
          },
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    const chunks = context.docs as Array<{ content: string }>;
    expect(chunks.length).toBe(2);
  });

  test("required chunk sources are never trimmed in non-template mode", async () => {
    const items = [
      { content: "high ".repeat(30), score: 0.9 },
      { content: "mid ".repeat(30), score: 0.5 },
      { content: "low ".repeat(30), score: 0.1 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_required_chunks_non_template",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize(item) {
            return {
              content: item.content,
              score: item.score,
            };
          },
        }),
      },
      policies: {
        require: ["docs"],
        budget: 1,
      },
    });

    const { context, trace } = await polo.resolve(task, {});
    expect(context.docs).toHaveLength(3);

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("chunks");
    if (docsRecord?.type === "chunks") {
      expect(docsRecord.chunks).toHaveLength(3);
      expect(docsRecord.chunks.every((chunk) => chunk.included)).toBe(true);
    }

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy).toBeUndefined();
  });

  test("non-required chunk source gets dropped policy when all chunks are over budget", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_chunks_full_drop_policy_record",
      sources: {
        guidelines: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return [
              { content: "long chunk that will be dropped ".repeat(20), score: 0.9 },
              { content: "another long chunk that will be dropped ".repeat(20), score: 0.8 },
            ];
          },
        }),
      },
      policies: {
        budget: 1,
      },
    });

    const { context, trace } = await polo.resolve(task, {});
    expect("guidelines" in context).toBe(false);

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "guidelines" && policy.action === "dropped",
    );
    expect(droppedPolicy?.reason).toBe("over_budget");

    const guidelinesRecord = trace.sources.find((source) => source.key === "guidelines");
    expect(guidelinesRecord?.type).toBe("chunks");
    if (guidelinesRecord?.type === "chunks") {
      expect(guidelinesRecord.chunks.every((chunk) => chunk.included === false)).toBe(true);
      expect(guidelinesRecord.chunks.every((chunk) => chunk.reason === "over_budget")).toBe(true);
    }
  });

  test("empty chunk source is not marked dropped", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_empty_chunks_not_dropped",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return [];
          },
        }),
      },
      policies: {
        budget: 1,
      },
    });

    const { context, trace } = await polo.resolve(task, {});
    expect(context.docs).toEqual([]);

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy).toBeUndefined();
  });

  test("chunks are sorted by score descending", async () => {
    const items = [
      { content: "low", score: 0.3 },
      { content: "high", score: 0.9 },
      { content: "mid", score: 0.6 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_chunks_order",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize(item) {
            return {
              content: item.content,
              score: item.score,
            };
          },
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    const chunks = context.docs as Array<{ content: string; score?: number }>;
    expect(chunks[0]?.content).toBe("high");
    expect(chunks[1]?.content).toBe("mid");
    expect(chunks[2]?.content).toBe("low");
  });

  test("throws when normalize returns invalid chunks", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_chunks_invalid_normalize",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return [{ value: "not-content" }];
          },
          normalize(item) {
            return {
              content: (item as { missing?: string }).missing as string,
            };
          },
        }),
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(
      /normalize\(\) must return Chunk objects with string content/,
    );
  });

  test("createChunks rejects invalid non-normalized items", async () => {
    await expect(createChunks(Promise.resolve([{ text: "not a chunk" }] as never))).rejects.toThrow(
      /requires either Chunk\[] input or a normalize function/,
    );
  });

  test("dependent chunk sources also reject invalid normalize output", async () => {
    const sharedSourceSet = polo.sourceSet((sources) => {
      const account = sources.value(emptyInputSchema, {
        async resolve() {
          return { id: "acc_1" };
        },
      });

      const docs = sources.chunks(
        emptyInputSchema,
        { account },
        {
          async resolve() {
            return [{ value: "not-content" }];
          },
          normalize(item) {
            return {
              content: (item as { missing?: string }).missing as string,
            };
          },
        },
      );

      return { account, docs };
    });

    const sourceRegistry = registerSources(sharedSourceSet);
    const task = polo.define(emptyInputSchema, {
      id: "test_dep_chunks_invalid_normalize",
      sources: {
        account: sourceRegistry.account,
        docs: sourceRegistry.docs,
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(
      /normalize\(\) must return Chunk objects with string content/,
    );
  });

  test("throws when a chunk source resolves malformed chunk envelopes", async () => {
    const malformedChunksSource = polo.source(emptyInputSchema, {
      async resolve() {
        return {
          _type: "chunks",
          items: [{ content: undefined }],
        };
      },
    });
    (malformedChunksSource as AnyResolverSource)._sourceKind = "chunks";

    const task = polo.define(emptyInputSchema, {
      id: "test_chunks_malformed_envelope",
      sources: {
        docs: malformedChunksSource,
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(/resolved malformed chunks/);
  });

  test("non-chunk sources over budget produce dropped policy records", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_non_chunk_over_budget_drop",
      sources: {
        requiredText: polo.source(emptyInputSchema, {
          resolve: async () => "keep me",
        }),
        extraText: polo.source(emptyInputSchema, {
          resolve: async () => "x".repeat(2_000),
        }),
      },
      policies: {
        require: ["requiredText"],
        budget: 10,
      },
    });

    const { context, trace } = await polo.resolve(task, {});
    expect(context.requiredText).toBe("keep me");
    expect("extraText" in context).toBe(false);

    const dropped = trace.policies.find(
      (policy) => policy.source === "extraText" && policy.action === "dropped",
    );
    expect(dropped?.reason).toBe("over_budget");
  });
});
