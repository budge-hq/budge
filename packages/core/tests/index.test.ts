import { describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import {
  createPolo,
  registerSources,
  RequiredSourceMissingError,
  type InferContext,
} from "../src/index.ts";
import { serialize } from "../src/pack.ts";

/* eslint-disable @typescript-eslint/restrict-template-expressions -- Tests intentionally interpolate render-aware context proxies. */

function expectType<T>(_value: T): void {
  // compile-time only
}

const polo = createPolo();
const emptyInputSchema = z.object({});

// ============================================================
// polo.source.fromInput
// ============================================================

describe("polo.source.fromInput", () => {
  test("passes through a call-time input value", async () => {
    const task = polo.define(
      z.object({
        transcript: z.string(),
      }),
      {
        id: "test_input",
        sources: {
          transcript: polo.source.fromInput("transcript"),
        },
      },
    );

    const { context } = await polo.resolve(task, { transcript: "hello world" });
    expect(context.transcript).toBe("hello world");
  });

  test("respects tags option", () => {
    const src = polo.source.fromInput("transcript", { tags: ["phi"] });
    expect(src._tags).toEqual(["phi"]);
  });

  test("defaults tags to empty array", () => {
    const src = polo.source.fromInput("transcript");
    expect(src._tags).toEqual([]);
  });
});

// ============================================================
// sources
// ============================================================

describe("sources", () => {
  test("resolves async value", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_source",
      sources: {
        account: polo.source(emptyInputSchema, {
          async resolve() {
            return {
              plan: "enterprise" as const,
              tier: "priority" as const,
            };
          },
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(context.account).toEqual({ plan: "enterprise", tier: "priority" });
  });

  test("dependent source waits for parent", async () => {
    const order: string[] = [];
    const parentSchema = z.object({ id: z.string() });
    const childSchema = z.object({ parentId: z.string() });
    type Parent = z.output<typeof parentSchema>;

    const task = polo.define(emptyInputSchema, {
      id: "test_dep",
      sources: {
        parent: polo.source(emptyInputSchema, {
          output: parentSchema,
          async resolve() {
            order.push("parent");
            return { id: "p1" };
          },
        }),
        child: polo.source(emptyInputSchema, {
          output: childSchema,
          async resolve({ context }: { context: { parent: Parent } }) {
            order.push("child");
            return { parentId: context.parent.id };
          },
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(order).toEqual(["parent", "child"]);
    expect(context.child).toEqual({ parentId: "p1" });
  });

  test("dependent source waits for parent when sources are destructured", async () => {
    const parentSchema = z.object({ id: z.string() });
    const childSchema = z.object({ parentId: z.string() });
    type Parent = z.output<typeof parentSchema>;

    const task = polo.define(emptyInputSchema, {
      id: "test_dep_destructured",
      sources: {
        parent: polo.source(emptyInputSchema, {
          output: parentSchema,
          async resolve() {
            return { id: "p1" };
          },
        }),
        child: polo.source(emptyInputSchema, {
          output: childSchema,
          async resolve({ context }: { context: { parent: Parent } }) {
            return { parentId: context.parent.id };
          },
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(context.child).toEqual({ parentId: "p1" });
  });

  test("independent sources resolve in parallel", async () => {
    const started: string[] = [];

    const task = polo.define(emptyInputSchema, {
      id: "test_parallel",
      sources: {
        a: polo.source(emptyInputSchema, {
          async resolve() {
            started.push("a");
            await new Promise((r) => setTimeout(r, 10));
            return "a_value";
          },
        }),
        b: polo.source(emptyInputSchema, {
          async resolve() {
            started.push("b");
            await new Promise((r) => setTimeout(r, 10));
            return "b_value";
          },
        }),
      },
    });

    const start = Date.now();
    const { context } = await polo.resolve(task, {});
    const elapsed = Date.now() - start;

    // Both started before either resolved
    expect(started).toContain("a");
    expect(started).toContain("b");
    expect(context.a).toBe("a_value");
    expect(context.b).toBe("b_value");
    // Would take ~20ms if sequential, ~10ms if parallel
    expect(elapsed).toBeLessThan(18);
  });

  test("string literals mentioning sources do not create fake dependencies", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_string_literal_false_positive",
      sources: {
        first: polo.source(emptyInputSchema, {
          resolve: async () => "sources.second should stay literal",
        }),
        second: polo.source(emptyInputSchema, {
          resolve: async () => "ready",
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(context.first).toBe("sources.second should stay literal");
    expect(context.second).toBe("ready");
  });

  test("comments mentioning sources do not create fake dependencies", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_comment_false_positive",
      sources: {
        first: polo.source(emptyInputSchema, {
          resolve: async () => {
            // sources.second is intentionally mentioned here as a comment
            return "ok";
          },
        }),
        second: polo.source(emptyInputSchema, {
          resolve: async () => "ready",
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(context.first).toBe("ok");
    expect(context.second).toBe("ready");
  });
});

// ============================================================
// derive
// ============================================================

describe("derive", () => {
  test("merges derived values onto context", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_derive",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ plan: "enterprise" as const }),
        }),
      },
      derive: ({ context }) => ({
        isEnterprise: context.account.plan === "enterprise",
      }),
    });

    const { context } = await polo.resolve(task, {});
    expect(context.isEnterprise).toBe(true);
  });

  test("derived values are available alongside source data", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_derive_coexist",
      sources: {
        user: polo.source(emptyInputSchema, {
          resolve: async () => ({ name: "Alice" }),
        }),
      },
      derive: ({ context }) => ({
        greeting: `Hello, ${context.user.name}`,
      }),
    });

    const { context } = await polo.resolve(task, {});
    expect(context.user?.name).toBe("Alice");
    expect(context.greeting).toBe("Hello, Alice");
  });
});

// ============================================================
// policies — require
// ============================================================

describe("policies.require", () => {
  test("throws when required source resolves to null", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_null",
      sources: {
        encounter: polo.source(emptyInputSchema, {
          resolve: async () => null,
        }),
      },
      policies: {
        require: ["encounter"],
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(RequiredSourceMissingError);
  });

  test("throws when required source resolves to undefined", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_undefined",
      sources: {
        encounter: polo.source(emptyInputSchema, {
          resolve: async () => undefined,
        }),
      },
      policies: {
        require: ["encounter"],
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(RequiredSourceMissingError);
  });

  test("does not throw when required source has a value", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_ok",
      sources: {
        encounter: polo.source(emptyInputSchema, {
          resolve: async () => ({ id: "enc_1" }),
        }),
      },
      policies: {
        require: ["encounter"],
      },
    });

    const { context } = await polo.resolve(task, {});
    expectType<{ id: string }>(context.encounter);
    expect(context.encounter).toEqual({ id: "enc_1" });
  });
});

// ============================================================
// policies — exclude
// ============================================================

describe("policies.exclude", () => {
  test("excluded source is absent from context", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_exclude",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: ["aspirin"] }),
        }),
        priorNote: polo.source(emptyInputSchema, {
          resolve: async () => ({ text: "prior note" }),
        }),
      },
      derive: ({ context }) => ({
        includeIntake: !context.priorNote,
      }),
      policies: {
        exclude: [
          ({ context }) =>
            !context.includeIntake
              ? {
                  source: "intake",
                  reason: "follow-up visits exclude patient intake",
                }
              : false,
        ],
      },
    });

    const { context } = await polo.resolve(task, {});
    // priorNote exists, so includeIntake is false, so intake is excluded
    expect("intake" in context).toBe(false);
    expect(context.priorNote).toBeDefined();
  });

  test("source is present when exclude returns false", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_no_exclude",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: ["aspirin"] }),
        }),
        priorNote: polo.source(emptyInputSchema, {
          resolve: async () => null,
        }),
      },
      derive: ({ context }) => ({
        includeIntake: !context.priorNote,
      }),
      policies: {
        exclude: [
          ({ context }) =>
            !context.includeIntake
              ? {
                  source: "intake",
                  reason: "follow-up visits exclude patient intake",
                }
              : false,
        ],
      },
    });

    const { context } = await polo.resolve(task, {});
    // priorNote is null, so includeIntake is true, intake is NOT excluded
    expect(context.intake).toEqual({ medications: ["aspirin"] });
  });

  test("exclude decision is recorded in trace", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_exclude_trace",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: [] }),
        }),
        priorNote: polo.source(emptyInputSchema, {
          resolve: async () => ({ text: "note" }),
        }),
      },
      derive: ({ context }) => ({
        includeIntake: !context.priorNote,
      }),
      policies: {
        exclude: [
          ({ context }) =>
            !context.includeIntake
              ? {
                  source: "intake",
                  reason: "follow-up visits exclude patient intake",
                }
              : false,
        ],
      },
    });

    const { trace } = await polo.resolve(task, {});
    const excluded = trace.policies.find((p) => p.action === "excluded");
    expect(excluded?.source).toBe("intake");
    expect(excluded?.reason).toBe("follow-up visits exclude patient intake");
  });
});

// ============================================================
// polo.source.chunks — budget packing
// ============================================================

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
        // budget tight enough to only fit 2 chunks (~17 tokens each with BPE tokenizer)
        budget: 40,
      },
    });

    const { context, trace } = await polo.resolve(task, {});
    const chunks = context.guidelines as Array<{ content: string }>;
    // At 25 tokens each, budget of 55 fits 2 chunks
    expect(chunks.length).toBe(2);

    // dropped chunk is in trace
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
});

// ============================================================
// Trace
// ============================================================

describe("trace", () => {
  test("trace contains source timing records", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_sources",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ id: "acc_1" }),
          tags: ["internal"],
        }),
      },
    });

    const { trace } = await polo.resolve(task, {});
    const sourceRecord = trace.sources.find((s) => s.key === "account");
    expect(sourceRecord).toBeDefined();
    expect(sourceRecord?.tags).toEqual(["internal"]);
    expect(typeof sourceRecord?.durationMs).toBe("number");
  });

  test("trace contains budget usage", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_budget",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => ({ value: "hello" }),
        }),
      },
      policies: { budget: 10_000 },
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.budget.max).toBe(10_000);
    expect(trace.budget.used).toBeGreaterThanOrEqual(0);
  });

  test("trace contains derived values", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_derived",
      sources: {
        account: polo.source(emptyInputSchema, {
          resolve: async () => ({ plan: "enterprise" as const }),
        }),
      },
      derive: ({ context }) => ({
        isEnterprise: context.account.plan === "enterprise",
      }),
    });

    const { trace } = await polo.resolve(task, {});
    expect(trace.derived["isEnterprise"]).toBe(true);
  });

  test("each run gets a unique runId", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_run_id",
      sources: {
        data: polo.source(emptyInputSchema, {
          resolve: async () => "x",
        }),
      },
    });

    const [r1, r2] = await Promise.all([polo.resolve(task, {}), polo.resolve(task, {})]);

    expect(r1.trace.runId).not.toBe(r2.trace.runId);
  });

  test("trace does not contain raw resolved data", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_trace_no_data",
      sources: {
        secret: polo.source(emptyInputSchema, {
          resolve: async () => ({ ssn: "123-45-6789" }),
          tags: ["phi"],
        }),
      },
    });

    const { trace } = await polo.resolve(task, {});
    const raw = JSON.stringify(trace);
    expect(raw).not.toContain("123-45-6789");
  });
});

// ============================================================
// serialize
// ============================================================

describe("serialize", () => {
  test("strings pass through unchanged", () => {
    expect(serialize("hello world")).toBe("hello world");
  });

  test("strings with label are prefixed", () => {
    expect(serialize("hello", "msg")).toBe("msg:\nhello");
  });

  test("null returns empty string", () => {
    expect(serialize(null)).toBe("");
  });

  test("undefined returns empty string", () => {
    expect(serialize(undefined)).toBe("");
  });

  test("objects are TOON-encoded", () => {
    const result = serialize({ name: "Alice", plan: "enterprise" });
    // TOON encoding should not be JSON
    expect(result).not.toBe('{"name":"Alice","plan":"enterprise"}');
    // Should be shorter than JSON
    expect(result.length).toBeLessThan(
      JSON.stringify({ name: "Alice", plan: "enterprise" }).length,
    );
  });

  test("objects with label add section header", () => {
    const result = serialize({ id: "1" }, "account");
    expect(result.startsWith("account:\n")).toBe(true);
  });

  test("arrays of uniform objects encode compactly", () => {
    const rows = [
      { id: "t1", subject: "Auth issue", score: 0.9 },
      { id: "t2", subject: "Billing", score: 0.8 },
    ];
    const toon = serialize(rows);
    const json = JSON.stringify(rows);
    // TOON should be shorter than JSON for uniform arrays
    expect(toon.length).toBeLessThan(json.length);
  });

  test("arrays with label add section header", () => {
    const result = serialize([{ id: "1" }], "tickets");
    expect(result.startsWith("tickets:\n")).toBe(true);
  });

  test("numbers and booleans are encoded", () => {
    expect(serialize(42)).not.toBe("");
    expect(serialize(true)).not.toBe("");
  });
});

// ============================================================
// template
// ============================================================

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
});

// ============================================================
// template — budget fitting
// ============================================================

describe("template budget fitting", () => {
  test("drops lowest-priority source when template output exceeds budget", async () => {
    // "default" source has lower priority than "preferred" and gets dropped first
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
        // very tight budget so extra gets dropped
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
    // extra was dropped due to budget
    expect(droppedLog).toContain("extra");
    // required source is always present
    expect(prompt?.prompt).toContain("short required text");
    // dropped record appears in trace policies
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
        // tight enough to force one drop
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
    // defaultIncluded should be dropped before preferred
    const defaultIdx = droppedSources.indexOf("defaultIncluded");
    const preferredIdx = droppedSources.indexOf("preferred");
    // defaultIncluded must appear first in the dropped list (if both dropped)
    if (defaultIdx !== -1 && preferredIdx !== -1) {
      expect(defaultIdx).toBeLessThan(preferredIdx);
    } else {
      // at minimum, defaultIncluded was dropped
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
        budget: 1, // impossibly small
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
        // prefer so the source is trimmed chunk-by-chunk rather than dropped whole
        prefer: ["docs"],
        // small enough to force chunk trimming but large enough to hold at least one chunk
        budget: 30,
      },
      template: ({ context }) => ({
        system: "",
        prompt: (context.docs ?? []).map((c) => c.content).join("\n"),
      }),
    });

    const { context } = await polo.resolve(task, {});
    const chunks = context.docs ?? [];
    // Should have fewer chunks than the original 3
    expect(chunks.length).toBeLessThan(3);
    // Highest-score chunk should be preserved (trimming removes lowest scores first)
    const contents = chunks.map((c) => c.content);
    expect(contents.some((c) => c.includes("chunk-high"))).toBe(true);
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
        // Enough room for transcript plus maybe some partial trimming attempts,
        // but not enough for the remaining docs to survive final fitting.
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

// ============================================================
// End-to-end — full story
// ============================================================

describe("end to end", () => {
  test("full workflow: input + source + derive + exclude + chunks + trace", async () => {
    const inputSchema = z.object({
      accountId: z.string(),
      transcript: z.string(),
    });
    const accountSourceInputSchema = z.object({
      accountId: z.string(),
    });
    const transcriptSourceInputSchema = z.object({
      transcript: z.string(),
    });
    const accountResult = {
      plan: "enterprise" as const,
      tier: "priority" as const,
    };
    const priorNoteResult = {
      text: "previous note",
    };
    type Account = typeof accountResult;

    const mockDb = {
      account: vi.fn(async (_accountId: string) => accountResult),
      priorNote: vi.fn(async (_plan: Account["plan"]) => priorNoteResult),
    };

    const mockVector = {
      search: vi.fn().mockResolvedValue([
        { pageContent: "guideline A ".repeat(5), score: 0.91 },
        { pageContent: "guideline B ".repeat(5), score: 0.87 },
        { pageContent: "guideline C ".repeat(200), score: 0.42 }, // will be over budget
      ] as Array<{ pageContent: string; score: number }>),
    };

    const sourceRegistry = registerSources({
      account: polo.source(accountSourceInputSchema, {
        tags: ["internal"],
        async resolve({ input }) {
          return mockDb.account(input.accountId);
        },
      }),
      priorNote: polo.source(accountSourceInputSchema, {
        async resolve({ context }: { context: { account: Account } }) {
          return mockDb.priorNote(context.account.plan);
        },
      }),
      guidelines: polo.source.chunks(transcriptSourceInputSchema, {
        tags: ["internal"],
        async resolve({ input }) {
          return mockVector.search(input.transcript) as Promise<
            Array<{ pageContent: string; score: number }>
          >;
        },
        normalize(item) {
          return {
            content: item.pageContent,
            score: item.score,
          };
        },
      }),
      sensitiveData: polo.source(accountSourceInputSchema, {
        tags: ["phi"],
        async resolve() {
          return { secret: "should be excluded" };
        },
      }),
    });

    const task = polo.define(inputSchema, {
      id: "e2e_test",
      sources: {
        transcript: polo.source.fromInput("transcript", { tags: ["restricted"] }),
        account: sourceRegistry.account,
        priorNote: sourceRegistry.priorNote,
        guidelines: sourceRegistry.guidelines,
        sensitiveData: sourceRegistry.sensitiveData,
      },
      derive: ({ context }) => ({
        isEnterprise: context.account.plan === "enterprise",
        replyStyle: context.account.tier === "priority" ? "concise" : "standard",
        hasPriorNote: !!context.priorNote,
      }),
      policies: {
        require: ["transcript", "account"],
        prefer: ["priorNote", "guidelines"],
        exclude: [
          () => ({
            source: "sensitiveData",
            reason: "sensitive data excluded from this task",
          }),
        ],
        budget: 500,
      },
    });

    const { context, trace } = await polo.resolve(task, {
      accountId: "acc_123",
      transcript: "patient says they feel better",
    });
    type TaskContext = InferContext<typeof task>;
    const typedContext: TaskContext = context;

    // sources present
    expectType<string>(typedContext.transcript);
    expectType<{ plan: "enterprise"; tier: "priority" }>(typedContext.account);
    expectType<{ text: string } | null | undefined>(typedContext.priorNote);
    expectType<Array<{ content: string; score?: number }> | undefined>(typedContext.guidelines);
    expect(context.transcript).toBe("patient says they feel better");
    expect(context.account).toEqual({ plan: "enterprise", tier: "priority" });
    expect(context.priorNote).toEqual({ text: "previous note" });

    // excluded source is absent
    expect("sensitiveData" in context).toBe(false);

    // derived values present
    expect(context.isEnterprise).toBe(true);
    expect(context.replyStyle).toBe("concise");
    expect(context.hasPriorNote).toBe(true);

    // chunk source present with packed results
    const guidelines = context.guidelines ?? [];
    expect(Array.isArray(guidelines)).toBe(true);
    expect(guidelines.length).toBeGreaterThan(0);

    // trace integrity
    expect(trace.taskId).toBe("e2e_test");
    expect(trace.runId).toBeTruthy();
    expect(trace.sources.length).toBeGreaterThan(0);
    expect(trace.budget.max).toBe(500);

    // exclusion in trace
    const excl = trace.policies.find((p) => p.action === "excluded");
    expect(excl?.source).toBe("sensitiveData");

    // raw secret not leaked into trace
    expect(JSON.stringify(trace)).not.toContain("should be excluded");
  });
});
