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
    const task = polo.define(emptyInputSchema, {
      id: "test_template_basic",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
        }),
      },
      template: ({ context }) => ({
        system: `You are helping ${context.account?.name}.`,
        prompt: `account:\n${context.account}`,
      }),
    });

    const result = await polo.resolve(task, {});
    expect(result.prompt).toBeDefined();
    expect(result.prompt?.system).toContain("Acme");
    expect(result.prompt?.prompt).toContain("account:");
    expect(result.prompt?.prompt).toContain("name: Acme");
  });

  test("no template means prompt is absent from resolution", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_no_template",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => "hello",
        }),
      },
    });

    const result = await polo.resolve(task, {});
    expect(result.prompt).toBeUndefined();
  });

  test("trace includes prompt metrics when template is used", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_trace",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme", plan: "enterprise" }),
        }),
      },
      template: ({ context }) => ({
        system: `You are a helpful assistant for ${context.account}.`,
        prompt: "done",
      }),
    });

    const { trace } = await polo.resolve(task, {});
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
    const task = polo.define(emptyInputSchema, {
      id: "test_template_trace_bigint",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => 1n,
        }),
      },
      template: () => ({
        system: "System prompt.",
        prompt: "ok",
      }),
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.prompt).toBeDefined();
    expect(typeof trace.prompt?.rawContextTokens).toBe("number");
    expect(typeof trace.prompt?.includedContextTokens).toBe("number");
  });

  test("trace token accounting does not throw for circular source values", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const task = polo.define(emptyInputSchema, {
      id: "test_template_trace_circular",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => circular,
        }),
      },
      template: () => ({
        system: "System prompt.",
        prompt: "ok",
      }),
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.prompt).toBeDefined();
    expect(typeof trace.prompt?.rawContextTokens).toBe("number");
    expect(typeof trace.prompt?.includedContextTokens).toBe("number");
  });

  test("included prompt metrics exclude policy-gated sources", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_included_metrics",
      sources: {
        visible: polo.source(emptyInputSchema, {
          resolve: async () => ({ text: "short" }),
        }),
        hidden: polo.source(emptyInputSchema, {
          resolve: async () => "x".repeat(2_000),
        }),
      },
      policies: {
        exclude: [() => ({ source: "hidden", reason: "hidden from prompt" })],
      },
      template: ({ context }) => ({
        system: "System prompt.",
        prompt: `${context.visible}`,
      }),
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.prompt?.rawContextTokens).toBeGreaterThan(
      trace.prompt?.includedContextTokens ?? 0,
    );
    expect(trace.prompt?.compressionRatio).toBeGreaterThan(
      trace.prompt?.includedCompressionRatio ?? 0,
    );
  });

  test("compression ratios are clamped at zero when templates add fixed overhead", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_clamped_compression_ratio",
      sources: {
        brief: polo.source(emptyInputSchema, {
          resolve: async () => "ok",
        }),
      },
      template: ({ context }) => ({
        system: `Instructions:\n${"Always be careful. ".repeat(100)}`,
        prompt: `${context.brief}`,
      }),
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.prompt?.compressionRatio).toBe(0);
    expect(trace.prompt?.includedCompressionRatio).toBe(0);
  });

  test("trace has no prompt key when no template is defined", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_no_template_trace",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => ({ value: 1 }),
        }),
      },
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.prompt).toBeUndefined();
  });

  test("template receives derived values in context", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_derived",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ plan: "enterprise" as const }),
        }),
      },
      derive: ({ context }) => ({
        isEnterprise: context.account.plan === "enterprise",
      }),
      template: ({ context }) => ({
        system: context.isEnterprise ? "Enterprise mode." : "Standard mode.",
        prompt: "",
      }),
    });

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.system).toBe("Enterprise mode.");
  });

  test("template handles undefined optional sources gracefully", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_optional",
      sources: {
        required: polo.source(emptyInputSchema, {
          resolve: async () => "present",
        }),
        optional: polo.source(emptyInputSchema, {
          resolve: async () => null,
        }),
      },
      template: ({ context }) => ({
        system: "System prompt.",
        prompt: `${context.required}${context.optional ? `\n${context.optional}` : ""}`,
      }),
    });

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.prompt).toBe("present");
  });

  test("system prompt can interpolate objects under the hood", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_system_object",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
        }),
      },
      template: ({ context }) => ({
        system: `System account:\n${context.account}`,
        prompt: "ok",
      }),
    });

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.system).toContain("name: Acme");
    expect(prompt?.system).toContain("plan: enterprise");
  });

  test("context.raw exposes original values for custom formatting", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_raw_escape_hatch",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
        }),
      },
      template: ({ context }) => ({
        system: `${context.account}`,
        prompt: JSON.stringify(context.raw.account),
      }),
    });

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.system).toContain("name: Acme");
    expect(prompt?.prompt).toBe('{"name":"Acme","plan":"enterprise"}');
  });

  test("literal slot-like text is not rewritten during materialization", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_slot_collision",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
        }),
        notes: polo.source(emptyInputSchema, {
          resolve: async () => "\u001fPOLO_SLOT_0\u001f",
        }),
      },
      template: ({ context }) => ({
        system: "System prompt.",
        prompt: `${context.account}\n${context.notes}`,
      }),
    });

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.prompt).toContain("name: Acme");
    expect(prompt?.prompt).toContain("\u001fPOLO_SLOT_0\u001f");
  });

  test("template proxy supports ownKeys and descriptor access for context.raw", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_proxy_raw_own_keys",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme" }),
        }),
      },
      template: ({ context }) => {
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

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.system).toContain("keys=account");
    expect(prompt?.system).toContain("hasRaw=true");
    expect(prompt?.prompt).toBe("raw-hidden");
  });

  test("template proxy materializes objects via toString/valueOf coercion", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_proxy_to_string_and_value_of",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Acme", plan: "enterprise" as const }),
        }),
      },
      template: ({ context }) => ({
        system: `${context.account}`,
        prompt: String(context.account?.valueOf()),
      }),
    });

    const { prompt } = await polo.resolve(task, {});
    expect(prompt?.system).toContain("name: Acme");
    expect(prompt?.prompt).toContain("plan: enterprise");
  });

  test("template path throws for malformed chunk envelopes", async () => {
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
      id: "test_template_malformed_chunk_envelope",
      sources: {
        docs: malformedChunksSource,
      },
      template: ({ context }) => ({
        system: "",
        prompt: `${context.docs ?? "none"}`,
      }),
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(/resolved malformed chunks/);
  });
});

describe("template budget fitting", () => {
  test("drops lowest-priority source when template output exceeds budget", async () => {
    const droppedLog: string[] = [];
    const task = polo.define(emptyInputSchema, {
      id: "test_template_drop_default",
      sources: {
        required: polo.source(emptyInputSchema, {
          resolve: async () => "short required text",
        }),
        extra: polo.source(emptyInputSchema, {
          resolve: async () => "x".repeat(500),
        }),
      },
      policies: {
        require: ["required"],
        budget: 5,
      },
      template: ({ context }) => {
        if (!("extra" in context)) droppedLog.push("extra");
        return {
          system: "sys",
          prompt: context.required + (context.extra ? String(context.extra) : ""),
        };
      },
    });

    const { prompt, trace } = await polo.resolve(task, {});
    expect(droppedLog).toContain("extra");
    expect(prompt?.prompt).toContain("short required text");
    const dropped = trace.policies.find(
      (p) => p.source === "extra" && p.action === "dropped" && p.reason === "over_budget",
    );
    expect(dropped).toBeDefined();
  });

  test("prefers to drop default-included before preferred sources", async () => {
    const droppedSources: string[] = [];
    const task = polo.define(emptyInputSchema, {
      id: "test_template_drop_order",
      sources: {
        required: polo.source(emptyInputSchema, {
          resolve: async () => "req",
        }),
        preferred: polo.source(emptyInputSchema, {
          resolve: async () => "p".repeat(200),
        }),
        defaultIncluded: polo.source(emptyInputSchema, {
          resolve: async () => "d".repeat(200),
        }),
      },
      policies: {
        require: ["required"],
        prefer: ["preferred"],
        budget: 10,
      },
      template: ({ context }) => {
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

    await polo.resolve(task, {});
    const defaultIdx = droppedSources.indexOf("defaultIncluded");
    const preferredIdx = droppedSources.indexOf("preferred");
    if (defaultIdx !== -1 && preferredIdx !== -1) {
      expect(defaultIdx).toBeLessThan(preferredIdx);
    } else {
      expect(droppedSources).toContain("defaultIncluded");
    }
  });

  test("required sources are never dropped even when over budget", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_template_required_never_dropped",
      sources: {
        critical: polo.source(emptyInputSchema, {
          resolve: async () => "c".repeat(1000),
        }),
      },
      policies: {
        require: ["critical"],
        budget: 1,
      },
      template: ({ context }) => ({
        system: "",
        prompt: String(context.critical),
      }),
    });

    const { context, prompt } = await polo.resolve(task, {});
    expect(context.critical).toBeDefined();
    expect(prompt?.prompt).toContain("c".repeat(100));
  });

  test("required chunk sources are never trimmed when over budget", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_template_required_chunk_never_trimmed",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize: (item) => ({ content: item.content, score: item.score }),
        }),
      },
      policies: {
        require: ["docs"],
        budget: 1,
      },
      template: ({ context }) => ({
        system: "",
        prompt: (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
      }),
    });

    const { context, prompt, trace } = await polo.resolve(task, {});
    expect(context.docs).toHaveLength(3);
    expect(prompt?.prompt).toContain("chunk-high");
    expect(prompt?.prompt).toContain("chunk-mid");
    expect(prompt?.prompt).toContain("chunk-low");

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

  test("chunks in template are trimmed when over budget", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_template_chunk_trim",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize: (item) => ({ content: item.content, score: item.score }),
        }),
      },
      policies: {
        prefer: ["docs"],
        budget: 30,
      },
      template: ({ context }) => ({
        system: "",
        prompt: (context.docs ?? []).map((c) => c.content).join("\n"),
      }),
    });

    const { context } = await polo.resolve(task, {});
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

    const task = polo.define(emptyInputSchema, {
      id: "test_template_chunk_trim_duplicate_content",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize: (item) => ({ content: item.content, score: item.score }),
        }),
      },
      policies: {
        prefer: ["docs"],
        budget,
      },
      template: ({ context }) => ({
        system: "",
        prompt: (context.docs ?? []).map((chunk) => chunk.content).join("\n"),
      }),
    });

    const { context, trace } = await polo.resolve(task, {});
    expect(context.docs).toHaveLength(1);
    expect(context.docs?.[0]?.score).toBe(0.9);

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("chunks");
    if (docsRecord?.type === "chunks") {
      expect(docsRecord.chunks).toEqual([
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

  test("dropping a chunk source whole clears all included chunk records", async () => {
    const items = [
      { content: "chunk-high ".repeat(10), score: 0.9 },
      { content: "chunk-mid ".repeat(10), score: 0.5 },
      { content: "chunk-low ".repeat(10), score: 0.1 },
    ];

    const task = polo.define(emptyInputSchema, {
      id: "test_template_chunk_whole_drop_trace",
      sources: {
        transcript: polo.source(emptyInputSchema, {
          resolve: async () => "t".repeat(120),
        }),
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return items;
          },
          normalize: (item) => ({ content: item.content, score: item.score }),
        }),
      },
      policies: {
        require: ["transcript"],
        prefer: ["docs"],
        budget: 25,
      },
      template: ({ context }) => ({
        system: "",
        prompt: `Transcript:\n${context.transcript}\n\nDocs:\n${context.docs ?? "N/A"}`,
      }),
    });

    const { prompt, trace } = await polo.resolve(task, {});
    expect(prompt?.prompt).not.toContain("chunk-high");

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("chunks");
    if (docsRecord?.type === "chunks") {
      expect(docsRecord.chunks.every((chunk) => !chunk.included)).toBe(true);
      expect(
        docsRecord.chunks.every((chunk) => chunk.reason === "source_dropped_over_budget"),
      ).toBe(true);
    }

    const droppedPolicy = trace.policies.find(
      (policy) => policy.source === "docs" && policy.action === "dropped",
    );
    expect(droppedPolicy?.reason).toBe("over_budget");
  });
});
