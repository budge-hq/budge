import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo } from "../src/index.ts";
import { estimateTokens } from "../src/pack.ts";
import type { AnyResolverSource } from "../src/types.ts";

/* eslint-disable @typescript-eslint/restrict-template-expressions -- Tests intentionally interpolate render-aware context proxies. */

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("template", () => {
  test("renders system and prompt from context", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_basic",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      template: (context) => ({
        system: `You are helping ${context.account?.name}.`,
        prompt: `account:\n${context.account}`,
      }),
    });

    const result = await run({});
    expect(result.prompt).toBeDefined();
    expect(result.prompt?.system).toContain("Acme");
    expect(result.prompt?.prompt).toContain("account:");
    expect(result.prompt?.prompt).toContain("name: Acme");
  });

  test("no template means prompt is absent from resolution", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_no_template",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          data: source(emptyInputSchema, {
            resolve: async () => "hello",
          }),
        })),
      },
    });

    const result = await run({});
    expect(result.prompt).toBeUndefined();
  });

  test("trace includes prompt metrics when template is used", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_trace",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" }),
          }),
        })),
      },
      template: (context) => ({
        system: `You are a helpful assistant for ${context.account}.`,
        prompt: "done",
      }),
    });

    const { traces } = await run({});
    expect(traces.prompt).toBeDefined();
    expect(traces.prompt?.systemTokens).toBeGreaterThan(0);
    expect(traces.prompt?.promptTokens).toBeGreaterThan(0);
    expect(traces.prompt?.totalTokens).toBe(
      (traces.prompt?.systemTokens ?? 0) + (traces.prompt?.promptTokens ?? 0),
    );
    expect(traces.prompt?.rawContextTokens).toBeGreaterThan(0);
    expect(traces.prompt?.includedContextTokens).toBeGreaterThan(0);
    expect(typeof traces.prompt?.compressionRatio).toBe("number");
    expect(typeof traces.prompt?.includedCompressionRatio).toBe("number");
  });

  test("trace token accounting does not throw for BigInt source values", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_trace_bigint",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          data: source(emptyInputSchema, {
            resolve: async () => 1n,
          }),
        })),
      },
      template: () => ({
        system: "System prompt.",
        prompt: "ok",
      }),
    });

    const { traces } = await run({});
    expect(traces.prompt).toBeDefined();
    expect(typeof traces.prompt?.rawContextTokens).toBe("number");
    expect(typeof traces.prompt?.includedContextTokens).toBe("number");
  });

  test("trace token accounting does not throw for circular source values", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_trace_circular",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          data: source(emptyInputSchema, {
            resolve: async () => circular,
          }),
        })),
      },
      template: () => ({
        system: "System prompt.",
        prompt: "ok",
      }),
    });

    const { traces } = await run({});
    expect(traces.prompt).toBeDefined();
    expect(typeof traces.prompt?.rawContextTokens).toBe("number");
    expect(typeof traces.prompt?.includedContextTokens).toBe("number");
  });

  test("raw is reserved as a selected source key at type level", () => {
    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error raw is reserved for template contexts
      polo.window({
        input: z.object({ raw: z.string() }),
        id: "typecheck_reserved_raw_source",
        sources: {
          raw: polo.input("raw"),
        },
      });
    }

    expect(true).toBe(true);
  });

  test("included prompt metrics exclude policy-gated sources", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_included_metrics",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          visible: source(emptyInputSchema, {
            resolve: async () => ({ text: "short" }),
          }),
          hidden: source(emptyInputSchema, {
            resolve: async () => "x".repeat(2_000),
          }),
        })),
      },
      policies: {
        exclude: [() => ({ source: "hidden", reason: "hidden from prompt" })],
      },
      template: (context) => ({
        system: "System prompt.",
        prompt: `${context.visible}`,
      }),
    });

    const { traces } = await run({});
    expect(traces.prompt?.rawContextTokens).toBeGreaterThan(
      traces.prompt?.includedContextTokens ?? 0,
    );
    expect(traces.prompt?.compressionRatio).toBeGreaterThan(
      traces.prompt?.includedCompressionRatio ?? 0,
    );
  });

  test("compression ratios are clamped at zero when templates add fixed overhead", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_clamped_compression_ratio",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          brief: source(emptyInputSchema, {
            resolve: async () => "ok",
          }),
        })),
      },
      template: (context) => ({
        system: `Instructions:\n${"Always be careful. ".repeat(100)}`,
        prompt: `${context.brief}`,
      }),
    });

    const { traces } = await run({});
    expect(traces.prompt?.compressionRatio).toBe(0);
    expect(traces.prompt?.includedCompressionRatio).toBe(0);
  });

  test("trace has no prompt key when no template is defined", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_no_template_trace",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          data: source(emptyInputSchema, {
            resolve: async () => ({ value: 1 }),
          }),
        })),
      },
    });

    const { traces } = await run({});
    expect(traces.prompt).toBeUndefined();
  });

  test("template receives derived values in context", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_derived",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ plan: "enterprise" as const }),
          }),
        })),
      },
      derive: (ctx) => ({
        isEnterprise: ctx.account!.plan === "enterprise",
      }),
      template: (context) => ({
        system: context.isEnterprise ? "Enterprise mode." : "Standard mode.",
        prompt: "",
      }),
    });

    const { prompt } = await run({});
    expect(prompt?.system).toBe("Enterprise mode.");
  });

  test("template handles undefined optional sources gracefully", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_optional",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          required: source(emptyInputSchema, {
            resolve: async () => "present",
          }),
          optional: source(emptyInputSchema, {
            resolve: async () => null,
          }),
        })),
      },
      template: (context) => ({
        system: "System prompt.",
        prompt: `${context.required}${context.optional ? `\n${context.optional}` : ""}`,
      }),
    });

    const { prompt } = await run({});
    expect(prompt?.prompt).toBe("present");
  });

  test("system prompt can interpolate objects under the hood", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_system_object",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      template: (context) => ({
        system: `System account:\n${context.account}`,
        prompt: "ok",
      }),
    });

    const { prompt } = await run({});
    expect(prompt?.system).toContain("name: Acme");
    expect(prompt?.system).toContain("plan: enterprise");
  });

  test("context.raw exposes original values for custom formatting", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_raw_escape_hatch",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      template: (context) => ({
        system: `${context.account}`,
        prompt: JSON.stringify(context.raw.account),
      }),
    });

    const { prompt } = await run({});
    expect(prompt?.system).toContain("name: Acme");
    expect(prompt?.prompt).toBe('{"name":"Acme","plan":"enterprise"}');
  });

  test("literal slot-like text is not rewritten during materialization", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_slot_collision",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
          notes: source(emptyInputSchema, {
            resolve: async () => "\u001fPOLO_SLOT_0\u001f",
          }),
        })),
      },
      template: (context) => ({
        system: "System prompt.",
        prompt: `${context.account}\n${context.notes}`,
      }),
    });

    const { prompt } = await run({});
    expect(prompt?.prompt).toContain("name: Acme");
    expect(prompt?.prompt).toContain("\u001fPOLO_SLOT_0\u001f");
  });

  test("template proxy supports ownKeys and descriptor access for context.raw", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_proxy_raw_own_keys",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme" }),
          }),
        })),
      },
      template: (context) => {
        const keys = Object.keys(context).sort().join(",");
        const hasRaw = "raw" in context;
        const rawDescriptor = Object.getOwnPropertyDescriptor(context, "raw");

        return {
          system: `keys=${keys} hasRaw=${hasRaw}`,
          prompt:
            rawDescriptor && rawDescriptor.enumerable === false ? "raw-hidden" : "raw-missing",
        };
      },
    });

    const { prompt } = await run({});
    expect(prompt?.system).toContain("keys=account");
    expect(prompt?.system).toContain("hasRaw=true");
    expect(prompt?.prompt).toBe("raw-hidden");
  });

  test("template proxy materializes objects via toString/valueOf coercion", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_proxy_to_string_and_value_of",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source(emptyInputSchema, {
            resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
          }),
        })),
      },
      template: (context) => ({
        system: `${context.account}`,
        prompt: String(context.account?.valueOf()),
      }),
    });

    const { prompt } = await run({});
    expect(prompt?.system).toContain("name: Acme");
    expect(prompt?.prompt).toContain("plan: enterprise");
  });

  test("template path throws for malformed chunk envelopes", async () => {
    const ragLikeSet = polo.sourceSet(({ source }) => ({
      docs: source(emptyInputSchema, {
        async resolve() {
          return {
            _type: "rag",
            items: [{ content: undefined }],
          };
        },
      }),
    }));
    (ragLikeSet.docs as AnyResolverSource)._sourceKind = "rag";

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_malformed_chunk_envelope",
      sources: {
        docs: ragLikeSet.docs,
      },
      template: (context) => ({
        system: "",
        prompt: `${context.docs ?? "none"}`,
      }),
    });

    await expect(run({})).rejects.toThrow(/resolved malformed rag items/);
  });
});

describe("template budget fitting", () => {
  test("drops lowest-priority source when template output exceeds budget", async () => {
    const droppedLog: string[] = [];
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_drop_default",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          required: source(emptyInputSchema, {
            resolve: async () => "short required text",
          }),
          extra: source(emptyInputSchema, {
            resolve: async () => "x".repeat(500),
          }),
        })),
      },
      policies: {
        require: ["required"],
        budget: 5,
      },
      template: (context) => {
        if (!("extra" in context)) droppedLog.push("extra");
        return {
          system: "sys",
          prompt: context.required + (context.extra ? String(context.extra) : ""),
        };
      },
    });

    const { prompt, traces } = await run({});
    expect(droppedLog).toContain("extra");
    expect(prompt?.prompt).toContain("short required text");
    const dropped = traces.policies.find(
      (p) => p.source === "extra" && p.action === "dropped" && p.reason === "over_budget",
    );
    expect(dropped).toBeDefined();
  });

  test("prefers to drop default-included before preferred sources", async () => {
    const droppedSources: string[] = [];
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_drop_order",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          required: source(emptyInputSchema, {
            resolve: async () => "req",
          }),
          preferred: source(emptyInputSchema, {
            resolve: async () => "p".repeat(200),
          }),
          defaultIncluded: source(emptyInputSchema, {
            resolve: async () => "d".repeat(200),
          }),
        })),
      },
      policies: {
        require: ["required"],
        prefer: ["preferred"],
        budget: 10,
      },
      template: (context) => {
        if (!("defaultIncluded" in context)) droppedSources.push("defaultIncluded");
        if (!("preferred" in context)) droppedSources.push("preferred");
        return {
          system: "",
          prompt: [
            context.required,
            "defaultIncluded" in context ? String(context.defaultIncluded) : "",
            "preferred" in context ? String(context.preferred) : "",
          ]
            .filter(Boolean)
            .join(" "),
        };
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
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_required_never_dropped",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          critical: source(emptyInputSchema, {
            resolve: async () => "c".repeat(1000),
          }),
        })),
      },
      policies: {
        require: ["critical"],
        budget: 1,
      },
      template: (context) => ({
        system: "",
        prompt: String(context.critical),
      }),
    });

    const { context, prompt } = await run({});
    expect(context.critical).toBeDefined();
    expect(prompt?.prompt).toContain("c".repeat(100));
  });

  test("required chunk sources are never trimmed when over budget", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_required_chunk_never_trimmed",
      sources: {
        ...polo.sourceSet(({ source }) => ({
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
      template: (context) => ({
        system: "",
        prompt: (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
      }),
    });

    const { context, prompt, traces } = await run({});
    expect(context.docs).toHaveLength(3);
    expect(prompt?.prompt).toContain("chunk-high");
    expect(prompt?.prompt).toContain("chunk-mid");
    expect(prompt?.prompt).toContain("chunk-low");

    const docsRecord = traces.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("rag");
    if (docsRecord?.type === "rag") {
      expect(docsRecord.items).toHaveLength(3);
      expect(docsRecord.items.every((chunk) => chunk.included)).toBe(true);
    }

    const droppedPolicy = traces.policies.find(
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

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_chunk_trim",
      sources: {
        ...polo.sourceSet(({ source }) => ({
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
      template: (context) => ({
        system: "",
        prompt: (context.docs ?? []).map((c) => c.content).join("\n"),
      }),
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

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_chunk_trim_duplicate_content",
      sources: {
        ...polo.sourceSet(({ source }) => ({
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
      template: (context) => ({
        system: "",
        prompt: (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
      }),
    });

    const { context, traces } = await run({});
    expect(context.docs).toHaveLength(1);
    expect(context.docs?.[0]?.score).toBe(0.9);

    const docsRecord = traces.sources.find((source) => source.key === "docs");
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

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_phase2_strategy_ordering",
      sources: {
        ...polo.sourceSet(({ source }) => ({
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
      template: (context) => ({
        system: "",
        prompt: (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
      }),
    });

    const { context, traces } = await run({});

    const docs = context.docs as Array<{ content: string; score?: number }>;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toBe(chunkB.content);

    const docsRecord = traces.sources.find((s) => s.key === "docs");
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

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_template_chunk_whole_drop_trace",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          transcript: source(emptyInputSchema, {
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
      template: (context) => ({
        system: "",
        prompt: `Transcript:\n${context.transcript}\n\nDocs:\n${context.docs ?? "N/A"}`,
      }),
    });

    const { prompt, traces } = await run({});
    expect(prompt?.prompt).not.toContain("chunk-high");

    const docsRecord = traces.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("rag");
    if (docsRecord?.type === "rag") {
      expect(docsRecord.items.every((chunk) => !chunk.included)).toBe(true);
      expect(docsRecord.items.every((chunk) => chunk.reason === "source_dropped_over_budget")).toBe(
        true,
      );
    }

    const droppedPolicy = traces.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy?.reason).toBe("over_budget");
  });
});
