import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";
import { estimateTokens } from "../src/pack.ts";
import type { AnyResolverSource } from "../src/types.ts";

/* eslint-disable @typescript-eslint/restrict-template-expressions -- Tests intentionally interpolate render-aware context proxies. */

const budge = createBudge();
const emptyInputSchema = z.object({});

describe("rendering", () => {
  test("renders system and prompt from context", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_basic",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      system: (context) => `You are helping ${context.account?.name}.`,
      prompt: (context) => `account:\n${context.account}`,
    });

    const result = await run({});
    expect(result.prompt).toBeDefined();
    expect(result.system).toContain("Acme");
    expect(result.prompt).toContain("account:");
    expect(result.prompt).toContain("name: Acme");
  });

  test("no template means prompt is absent from resolution", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_no_template",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          data: source.value(emptyInputSchema, {
            resolve: async () => "hello",
          }),
        })),
      },
    });

    const result = await run({});
    expect(result.prompt).toBeUndefined();
  });

  test("trace includes prompt metrics when template is used", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_trace",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" }),
          }),
        })),
      },
      system: (context) => `You are a helpful assistant for ${context.account}.`,
      prompt: "done",
    });

    const { trace } = await run({});
    expect(trace.prompt).toBeDefined();
    expect(trace.prompt?.systemTokens).toBeGreaterThan(0);
    expect(trace.prompt?.promptTokens).toBeGreaterThan(0);
    expect(trace.prompt?.totalTokens).toBe(
      (trace.prompt?.systemTokens ?? 0) + (trace.prompt?.promptTokens ?? 0),
    );
    expect(trace.prompt?.rawContextTokens).toBeGreaterThan(0);
    expect(trace.prompt?.includedContextTokens).toBeGreaterThan(0);
    expect(typeof trace.prompt?.compressionRatio).toBe("number");
    expect(typeof trace.prompt?.includedCompressionRatio).toBe("number");
  });

  test("trace token accounting does not throw for BigInt source values", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_trace_bigint",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          data: source.value(emptyInputSchema, {
            resolve: async () => 1n,
          }),
        })),
      },
      system: "System prompt.",
      prompt: "ok",
    });

    const { trace } = await run({});
    expect(trace.prompt).toBeDefined();
    expect(typeof trace.prompt?.rawContextTokens).toBe("number");
    expect(typeof trace.prompt?.includedContextTokens).toBe("number");
  });

  test("trace token accounting does not throw for circular source values", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_trace_circular",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          data: source.value(emptyInputSchema, {
            resolve: async () => circular,
          }),
        })),
      },
      system: "System prompt.",
      prompt: "ok",
    });

    const { trace } = await run({});
    expect(trace.prompt).toBeDefined();
    expect(typeof trace.prompt?.rawContextTokens).toBe("number");
    expect(typeof trace.prompt?.includedContextTokens).toBe("number");
  });

  test("raw is reserved as a selected source key at type level", () => {
    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error raw is reserved for render contexts
      budge.window({
        input: z.object({ raw: z.string() }),
        id: "typecheck_reserved_raw_source",
        sources: {
          raw: budge.input("raw"),
        },
      });
    }

    expect(true).toBe(true);
  });

  test("included prompt metrics exclude policy-gated sources", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_included_metrics",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          visible: source.value(emptyInputSchema, {
            resolve: async () => ({ text: "short" }),
          }),
          hidden: source.value(emptyInputSchema, {
            resolve: async () => "x".repeat(2_000),
          }),
        })),
      },
      policies: {
        exclude: [() => ({ source: "hidden", reason: "hidden from prompt" })],
      },
      system: "System prompt.",
      prompt: (context) => `${context.visible}`,
    });

    const { trace } = await run({});
    expect(trace.prompt?.rawContextTokens).toBeGreaterThan(
      trace.prompt?.includedContextTokens ?? 0,
    );
    expect(trace.prompt?.compressionRatio).toBeGreaterThan(
      trace.prompt?.includedCompressionRatio ?? 0,
    );
  });

  test("compression ratios are clamped at zero when templates add fixed overhead", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_clamped_compression_ratio",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          brief: source.value(emptyInputSchema, {
            resolve: async () => "ok",
          }),
        })),
      },
      system: `Instructions:\n${"Always be careful. ".repeat(100)}`,
      prompt: (context) => `${context.brief}`,
    });

    const { trace } = await run({});
    expect(trace.prompt?.compressionRatio).toBe(0);
    expect(trace.prompt?.includedCompressionRatio).toBe(0);
  });

  test("trace has no prompt key when no template is defined", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_no_template_trace",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          data: source.value(emptyInputSchema, {
            resolve: async () => ({ value: 1 }),
          }),
        })),
      },
    });

    const { trace } = await run({});
    expect(trace.prompt).toBeUndefined();
  });

  test("prompt receives derived values in context", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_derived",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ plan: "enterprise" as const }),
          }),
        })),
      },
      derive: (ctx) => ({
        isEnterprise: ctx.account!.plan === "enterprise",
      }),
      system: (context) => (context.isEnterprise ? "Enterprise mode." : "Standard mode."),
      prompt: "",
    });

    const { system } = await run({});
    expect(system).toBe("Enterprise mode.");
  });

  test("prompt handles undefined optional sources gracefully", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_optional",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          required: source.value(emptyInputSchema, {
            resolve: async () => "present",
          }),
          optional: source.value(emptyInputSchema, {
            resolve: async () => null,
          }),
        })),
      },
      system: "System prompt.",
      prompt: (context) => `${context.required}${context.optional ? `\n${context.optional}` : ""}`,
    });

    const { prompt } = await run({});
    expect(prompt).toBe("present");
  });

  test("system prompt can interpolate objects under the hood", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_system_object",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      system: (context) => `System account:\n${context.account}`,
      prompt: "ok",
    });

    const { system } = await run({});
    expect(system).toContain("name: Acme");
    expect(system).toContain("plan: enterprise");
  });

  test("context.raw exposes original values for custom formatting", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_raw_escape_hatch",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      system: (context) => `${context.account}`,
      prompt: (context) => JSON.stringify(context.raw.account),
    });

    const { system, prompt } = await run({});
    expect(system).toContain("name: Acme");
    expect(prompt).toBe('{"name":"Acme","plan":"enterprise"}');
  });

  test("literal slot-like text is not rewritten during materialization", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_slot_collision",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
          notes: source.value(emptyInputSchema, {
            resolve: async () => "\u001fBUDGE_SLOT_0\u001f",
          }),
        })),
      },
      system: "System prompt.",
      prompt: (context) => `${context.account}\n${context.notes}`,
    });

    const { prompt } = await run({});
    expect(prompt).toContain("name: Acme");
    expect(prompt).toContain("\u001fBUDGE_SLOT_0\u001f");
  });

  test("render context supports ownKeys and descriptor access for context.raw", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_proxy_raw_own_keys",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme" }),
          }),
        })),
      },
      system: (context) => {
        const keys = Object.keys(context).sort().join(",");
        const hasRaw = "raw" in context;
        const rawDescriptor = Object.getOwnPropertyDescriptor(context, "raw");

        void rawDescriptor;
        return `keys=${keys} hasRaw=${hasRaw}`;
      },
      prompt: (context) => {
        const rawDescriptor = Object.getOwnPropertyDescriptor(context, "raw");
        return rawDescriptor && rawDescriptor.enumerable === false ? "raw-hidden" : "raw-missing";
      },
    });

    const { system, prompt } = await run({});
    expect(system).toContain("keys=account");
    expect(system).toContain("hasRaw=true");
    expect(prompt).toBe("raw-hidden");
  });

  test("render context materializes objects via toString/valueOf coercion", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_proxy_to_string_and_value_of",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      system: (context) => `${context.account}`,
      prompt: (context) => String(context.account?.valueOf()),
    });

    const { system, prompt } = await run({});
    expect(system).toContain("name: Acme");
    expect(prompt).toContain("plan: enterprise");
  });

  test("render path throws for malformed chunk envelopes", async () => {
    const ragLikeSet = budge.sourceSet(({ source }) => ({
      docs: source.value(emptyInputSchema, {
        async resolve() {
          return {
            _type: "rag",
            items: [{ content: undefined }],
          };
        },
      }),
    }));
    (ragLikeSet.docs as AnyResolverSource)._sourceKind = "rag";

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_malformed_chunk_envelope",
      sources: {
        docs: ragLikeSet.docs,
      },
      system: "",
      prompt: (context) => `${context.docs ?? "none"}`,
    });

    await expect(run({})).rejects.toThrow(/resolved malformed rag items/);
  });
});

describe("render budget fitting", () => {
  test("drops lowest-priority source when prompt output exceeds budget", async () => {
    const droppedLog: string[] = [];
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_drop_default",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          required: source.value(emptyInputSchema, {
            resolve: async () => "short required text",
          }),
          extra: source.value(emptyInputSchema, {
            resolve: async () => "x".repeat(500),
          }),
        })),
      },
      policies: {
        require: ["required"],
        budget: 5,
      },
      system: "sys",
      prompt: (context) => {
        if (!("extra" in context)) droppedLog.push("extra");
        return context.required + (context.extra ? String(context.extra) : "");
      },
    });

    const { prompt, trace } = await run({});
    expect(droppedLog).toContain("extra");
    expect(prompt).toContain("short required text");
    const dropped = trace.policies.find(
      (p) => p.source === "extra" && p.action === "dropped" && p.reason === "over_budget",
    );
    expect(dropped).toBeDefined();
  });

  test("prefers to drop default-included before preferred sources", async () => {
    const droppedSources: string[] = [];
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_drop_order",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          required: source.value(emptyInputSchema, {
            resolve: async () => "req",
          }),
          preferred: source.value(emptyInputSchema, {
            resolve: async () => "p".repeat(200),
          }),
          defaultIncluded: source.value(emptyInputSchema, {
            resolve: async () => "d".repeat(200),
          }),
        })),
      },
      policies: {
        require: ["required"],
        prefer: ["preferred"],
        budget: 10,
      },
      system: "",
      prompt: (context) => {
        if (!("defaultIncluded" in context)) droppedSources.push("defaultIncluded");
        if (!("preferred" in context)) droppedSources.push("preferred");
        return [
          context.required,
          "defaultIncluded" in context ? String(context.defaultIncluded) : "",
          "preferred" in context ? String(context.preferred) : "",
        ]
          .filter(Boolean)
          .join(" ");
      },
    });

    await run({});
    const defaultIdx = droppedSources.indexOf("defaultIncluded");
    const preferredIdx = droppedSources.indexOf("preferred");
    if (defaultIdx !== -1 && preferredIdx !== -1) {
      expect(defaultIdx).toBeLessThan(preferredIdx);
    } else {
      expect(droppedSources).toContain("defaultIncluded");
    }
  });

  test("required sources are never dropped even when over budget", async () => {
    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_required_never_dropped",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          critical: source.value(emptyInputSchema, {
            resolve: async () => "c".repeat(1000),
          }),
        })),
      },
      policies: {
        require: ["critical"],
        budget: 1,
      },
      system: "",
      prompt: (context) => String(context.critical),
    });

    const { context, prompt } = await run({});
    expect(context.critical).toBeDefined();
    expect(prompt).toContain("c".repeat(100));
  });

  test("required chunk sources are never trimmed when over budget", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_required_chunk_never_trimmed",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize: (item) => ({ content: item.content, score: item.score }),
          }),
        })),
      },
      policies: {
        require: ["docs"],
        budget: 1,
      },
      system: "",
      prompt: (context) => (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
    });

    const { context, prompt, trace } = await run({});
    expect(context.docs).toHaveLength(3);
    expect(prompt).toContain("chunk-high");
    expect(prompt).toContain("chunk-mid");
    expect(prompt).toContain("chunk-low");

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("rag");
    if (docsRecord?.type === "rag") {
      expect(docsRecord.items).toHaveLength(3);
      expect(docsRecord.items.every((chunk) => chunk.included)).toBe(true);
    }

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy).toBeUndefined();
  });

  test("chunks in template are trimmed when over budget", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_chunk_trim",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize: (item) => ({ content: item.content, score: item.score }),
          }),
        })),
      },
      policies: {
        prefer: ["docs"],
        budget: 30,
      },
      system: "",
      prompt: (context) => (context.docs ?? []).map((c) => c.content).join("\n"),
    });

    const { context } = await run({});
    const chunks = context.docs ?? [];
    expect(chunks.length).toBeLessThan(3);
    const contents = chunks.map((c) => c.content);
    expect(contents.some((c) => c.includes("chunk-high"))).toBe(true);
  });

  test("chunk trimming updates the matching trace record when content is duplicated", async () => {
    const items = [
      { content: "duplicate ".repeat(20), score: 0.9 },
      { content: "duplicate ".repeat(20), score: 0.1 },
    ];
    const budget = estimateTokens(items.map((item) => item.content).join("\n")) - 1;

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_chunk_trim_duplicate_content",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize: (item) => ({ content: item.content, score: item.score }),
          }),
        })),
      },
      policies: {
        prefer: ["docs"],
        budget,
      },
      system: "",
      prompt: (context) => (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
    });

    const { context, trace } = await run({});
    expect(context.docs).toHaveLength(1);
    expect(context.docs?.[0]?.score).toBe(0.9);

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("rag");
    if (docsRecord?.type === "rag") {
      expect(docsRecord.items).toEqual([
        {
          content: "duplicate ".repeat(20),
          score: 0.9,
          included: true,
        },
        {
          content: "duplicate ".repeat(20),
          score: 0.1,
          included: false,
          reason: "chunk_trimmed_over_budget",
        },
      ]);
    }
  });

  test("Phase 2 trimming respects scorePerToken strategy ordering", async () => {
    const chunkA = { content: "x".repeat(200), score: 0.9 };
    const chunkB = { content: "y".repeat(20), score: 0.2 };

    const bothRendered = [chunkA.content, chunkB.content].join("\n");
    const budget = estimateTokens(bothRendered) - 1;

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_phase2_strategy_ordering",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return [chunkA, chunkB];
            },
            normalize: (item) => ({ content: item.content, score: item.score }),
          }),
        })),
      },
      policies: {
        prefer: ["docs"],
        budget: { maxTokens: budget, strategy: { type: "score_per_token" } },
      },
      system: "",
      prompt: (context) => (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
    });

    const { context, trace } = await run({});

    const docs = context.docs as Array<{ content: string; score?: number }>;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toBe(chunkB.content);

    const docsRecord = trace.sources.find((s) => s.key === "docs");
    if (docsRecord?.type === "rag") {
      const kept = docsRecord.items.find((c) => c.included);
      const dropped = docsRecord.items.find((c) => !c.included);
      expect(kept?.score).toBe(0.2);
      expect(dropped?.score).toBe(0.9);
      expect(dropped?.reason).toBe("chunk_trimmed_over_budget");
    }
  });

  test("dropping a chunk source whole clears all included chunk records", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_template_chunk_whole_drop_trace",
      sources: {
        ...budge.sourceSet(({ source }) => ({
          transcript: source.value(emptyInputSchema, {
            resolve: async () => "t".repeat(120),
          }),
          docs: source.rag(emptyInputSchema, {
            async resolve() {
              return items;
            },
            normalize: (item) => ({ content: item.content, score: item.score }),
          }),
        })),
      },
      policies: {
        require: ["transcript"],
        prefer: ["docs"],
        budget: 25,
      },
      system: "",
      prompt: (context) => `Transcript:\n${context.transcript}\n\nDocs:\n${context.docs ?? "N/A"}`,
    });

    const { prompt, trace } = await run({});
    expect(prompt).not.toContain("chunk-high");

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("rag");
    if (docsRecord?.type === "rag") {
      expect(docsRecord.items.every((chunk) => !chunk.included)).toBe(true);
      expect(docsRecord.items.every((chunk) => chunk.reason === "source_dropped_over_budget")).toBe(
        true,
      );
    }

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy?.reason).toBe("over_budget");
  });
});
