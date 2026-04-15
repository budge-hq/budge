import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createBudge } from "../src/budge.ts";
import { extractCachedTokens, withPromptCaching } from "../src/cache.ts";
import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Helpers to invoke the middleware transform directly
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// We test transformParams directly by importing the internal middleware.
// Since createCachingMiddleware is not exported, we exercise the transform
// through withPromptCaching by giving it a fake model and observing what
// params reach the inner doGenerate.
// ---------------------------------------------------------------------------

type PromptMessage = {
  role: string;
  content:
    | string
    | Array<{ type: string; text: string; providerOptions?: Record<string, unknown> }>;
  providerOptions?: Record<string, unknown>;
};

type FakeParams = {
  prompt: PromptMessage[];
  [key: string]: unknown;
};

/**
 * Builds a fake LanguageModel that captures the params passed to doGenerate
 * and resolves with a minimal result. Used to observe what the middleware
 * transforms before the call reaches the underlying model.
 */
function makeCaptureModel(captured: { params?: FakeParams }) {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake-model",
    defaultObjectGenerationMode: undefined,
    supportedUrls: undefined,
    async doGenerate(params: FakeParams) {
      captured.params = params;
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        rawValue: {},
        request: {},
        response: { id: "test", timestamp: new Date(), modelId: "fake" },
        warnings: [],
      };
    },
    async doStream(params: FakeParams) {
      captured.params = params;
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stream,
        rawValue: {},
        request: {},
        warnings: [],
      };
    },
  } as unknown as LanguageModel;
}

/**
 * Invokes the middleware by calling doGenerate on a wrapped capture model.
 */
async function runTransform(params: FakeParams): Promise<FakeParams> {
  const captured: { params?: FakeParams } = {};
  const fakeModel = makeCaptureModel(captured);
  const wrapped = withPromptCaching(fakeModel) as unknown as {
    doGenerate: (p: FakeParams) => Promise<unknown>;
  };
  await wrapped.doGenerate(params);
  return captured.params ?? params;
}

// ---------------------------------------------------------------------------
// Minimal params factory
// ---------------------------------------------------------------------------

function makeParams(prompt: PromptMessage[]): FakeParams {
  return { prompt };
}

function sysMsg(
  content: string | PromptMessage["content"],
  providerOptions?: Record<string, unknown>,
): PromptMessage {
  return { role: "system", content, ...(providerOptions ? { providerOptions } : {}) };
}

function userMsg(content: string): PromptMessage {
  return { role: "user", content };
}

function textPart(text: string, providerOptions?: Record<string, unknown>) {
  return { type: "text", text, ...(providerOptions ? { providerOptions } : {}) };
}

// ---------------------------------------------------------------------------
// Tests: middleware transformParams
// ---------------------------------------------------------------------------

describe("createCachingMiddleware transformParams", () => {
  it("system message has anthropic and gateway markers added when content is a string", async () => {
    const params = makeParams([sysMsg("You are helpful."), userMsg("Hello")]);
    const result = await runTransform(params);

    const sys = result.prompt.find((m) => m.role === "system")!;
    expect(sys.providerOptions).toBeDefined();
    expect((sys.providerOptions as any)?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    expect((sys.providerOptions as any)?.gateway?.caching).toBe("auto");
  });

  it("system message as string: user messages are not modified", async () => {
    const params = makeParams([sysMsg("System prompt"), userMsg("User message")]);
    const result = await runTransform(params);

    const user = result.prompt.find((m) => m.role === "user")!;
    expect(user.providerOptions).toBeUndefined();
  });

  it("preserves existing providerOptions on the system message via merge", async () => {
    const params = makeParams([
      sysMsg("System prompt", { openai: { someOption: "value" } }),
      userMsg("Hello"),
    ]);
    const result = await runTransform(params);

    const sys = result.prompt.find((m) => m.role === "system")!;
    const opts = sys.providerOptions as any;
    // Pre-existing OpenAI option preserved
    expect(opts?.openai?.someOption).toBe("value");
    // New markers added
    expect(opts?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    expect(opts?.gateway?.caching).toBe("auto");
  });

  it("deep-merges existing anthropic providerOptions on the system message", async () => {
    const params = makeParams([
      sysMsg("System prompt", { anthropic: { other: "field" } }),
      userMsg("Hello"),
    ]);
    const result = await runTransform(params);

    const sys = result.prompt.find((m) => m.role === "system")!;
    const opts = sys.providerOptions as any;
    // Existing anthropic field preserved
    expect(opts?.anthropic?.other).toBe("field");
    // New cache marker added
    expect(opts?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("is idempotent: running the transform twice produces the same result", async () => {
    const params = makeParams([sysMsg("You are helpful."), userMsg("Hi")]);

    // First pass
    const firstResult = await runTransform(params);
    // Simulate second pass by re-running with first-pass output
    const secondResult = await runTransform(firstResult as FakeParams);

    const sys1 = firstResult.prompt.find((m) => m.role === "system")!;
    const sys2 = secondResult.prompt.find((m) => m.role === "system")!;

    // Both passes should produce the same providerOptions
    expect(sys1.providerOptions).toEqual(sys2.providerOptions);

    // Specifically, cacheControl should not be duplicated or changed
    const opts1 = sys1.providerOptions as any;
    const opts2 = sys2.providerOptions as any;
    expect(opts1?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    expect(opts2?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("does not modify user messages even when they have content arrays", async () => {
    const params = makeParams([
      sysMsg("System prompt"),
      {
        role: "user",
        content: [textPart("Part A"), textPart("Part B")],
      },
    ]);
    const result = await runTransform(params);

    const user = result.prompt.find((m) => m.role === "user")!;
    const content = user.content as Array<{
      type: string;
      text: string;
      providerOptions?: unknown;
    }>;
    // User parts are untouched
    expect(content[0]?.providerOptions).toBeUndefined();
    expect(content[1]?.providerOptions).toBeUndefined();
    expect(user.providerOptions).toBeUndefined();
  });

  it("is a noop when there is no system message", async () => {
    const params = makeParams([userMsg("No system message here")]);
    const result = await runTransform(params);

    expect(result.prompt).toHaveLength(1);
    expect(result.prompt[0]!.role).toBe("user");
    expect(result.prompt[0]!.providerOptions).toBeUndefined();
  });

  it("falls back to original params and logs debug when transform throws", async () => {
    // We exercise this by wrapping a model that throws in doGenerate after
    // transform, so we need a different approach: directly test the catch path
    // by having the prompt array itself throw when iterated.
    //
    // Simpler: use a Proxy on prompt that throws on findIndex.
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const throwingPrompt = new Proxy([] as PromptMessage[], {
      get(target, prop) {
        if (prop === "findIndex") {
          return () => {
            throw new Error("findIndex exploded");
          };
        }
        return Reflect.get(target, prop);
      },
    });

    const params = { prompt: throwingPrompt } as unknown as FakeParams;
    const captured: { params?: FakeParams } = {};
    const fakeModel = makeCaptureModel(captured);
    const wrapped = withPromptCaching(fakeModel) as unknown as {
      doGenerate: (p: FakeParams) => Promise<unknown>;
    };

    // Should not throw — middleware catches and falls back
    await wrapped.doGenerate(params);

    // The original (untransformed) params should have been passed through
    expect(captured.params?.prompt).toBe(throwingPrompt);

    // console.debug should have been called with the error message
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("budge: prompt caching transform failed"),
      expect.any(Error),
    );

    debugSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: extractCachedTokens
// ---------------------------------------------------------------------------

describe("extractCachedTokens", () => {
  it("returns cachedInputTokens from inputTokenDetails when present (canonical AI SDK v6 field)", () => {
    const result = extractCachedTokens(
      { anthropic: { cacheReadInputTokens: 999 } },
      { inputTokenDetails: { cacheReadTokens: 42 }, cachedInputTokens: 10 },
    );
    expect(result).toBe(42);
  });

  it("falls back to deprecated top-level cachedInputTokens when inputTokenDetails is absent", () => {
    const result = extractCachedTokens(
      { anthropic: { cacheReadInputTokens: 999 } },
      { cachedInputTokens: 17 },
    );
    expect(result).toBe(17);
  });

  it("falls back to Anthropic provider metadata cacheReadInputTokens", () => {
    const result = extractCachedTokens({ anthropic: { cacheReadInputTokens: 100 } }, undefined);
    expect(result).toBe(100);
  });

  it("falls back to OpenAI provider metadata cachedPromptTokens", () => {
    const result = extractCachedTokens({ openai: { cachedPromptTokens: 50 } }, undefined);
    expect(result).toBe(50);
  });

  it("falls back to Google provider metadata cachedContentTokenCount", () => {
    const result = extractCachedTokens({ google: { cachedContentTokenCount: 25 } }, undefined);
    expect(result).toBe(25);
  });

  it("falls back to OpenRouter snake_case cache_read_input_tokens", () => {
    const result = extractCachedTokens({ openrouter: { cache_read_input_tokens: 75 } }, undefined);
    expect(result).toBe(75);
  });

  it("returns 0 when nothing is set", () => {
    const result = extractCachedTokens(undefined, undefined);
    expect(result).toBe(0);
  });

  it("returns 0 when providerMetadata is empty and usage has no cache fields", () => {
    const result = extractCachedTokens({}, { inputTokenDetails: { cacheReadTokens: undefined } });
    expect(result).toBe(0);
  });

  it("returns 0 defensively when fields are present but not numbers", () => {
    const result = extractCachedTokens(
      {
        anthropic: { cacheReadInputTokens: "not-a-number" },
        openai: { cachedPromptTokens: null },
        google: { cachedContentTokenCount: true },
        openrouter: { cache_read_input_tokens: {} },
      },
      {
        inputTokenDetails: { cacheReadTokens: undefined },
        cachedInputTokens: undefined,
      },
    );
    expect(result).toBe(0);
  });

  it("prefers inputTokenDetails over all provider metadata when both are present", () => {
    const result = extractCachedTokens(
      {
        anthropic: { cacheReadInputTokens: 500 },
        openai: { cachedPromptTokens: 300 },
      },
      { inputTokenDetails: { cacheReadTokens: 7 } },
    );
    expect(result).toBe(7);
  });

  it("prefers Anthropic metadata over OpenAI when inputTokenDetails is absent", () => {
    const result = extractCachedTokens(
      {
        anthropic: { cacheReadInputTokens: 100 },
        openai: { cachedPromptTokens: 50 },
      },
      {},
    );
    expect(result).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Integration: createBudge wires withPromptCaching
// ---------------------------------------------------------------------------

const { mockGenerate, agentInstances } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  agentInstances: [] as Array<{ settings: Record<string, unknown> }>,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    ToolLoopAgent: class MockToolLoopAgent {
      constructor(public settings: Record<string, unknown>) {
        agentInstances.push(this);
      }
      generate = mockGenerate;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  agentInstances.length = 0;
});

describe("createBudge prompt caching integration", () => {
  function makeAdapter() {
    return {
      describe: () => "test source",
      list: vi.fn(async () => []),
      read: vi.fn(async (path: string) => `contents of ${path}`),
    };
  }

  it("passes a wrapped model to ToolLoopAgent, not the raw model", async () => {
    const fakeOrchestrator = { specificationVersion: "v3" as const } as LanguageModel;
    const fakeWorker = { specificationVersion: "v3" as const } as LanguageModel;

    mockGenerate.mockResolvedValue({
      text: "done",
      steps: [{ toolResults: [{ toolName: "finish", output: "final answer" }] }],
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 0 } },
      providerMetadata: {},
    });

    const budge = createBudge({ orchestrator: fakeOrchestrator, worker: fakeWorker });
    await budge.prepare({
      task: "test task",
      sources: { s: makeAdapter() },
    });

    // ToolLoopAgent should have been constructed at least once
    expect(agentInstances.length).toBeGreaterThan(0);

    // The model passed to ToolLoopAgent should NOT be the raw fake model.
    // It should be a wrapped LanguageModelV3 with specificationVersion "v3".
    const modelArg = agentInstances[0]!.settings.model as { specificationVersion?: string };
    expect(modelArg).not.toBe(fakeOrchestrator);
    expect(modelArg.specificationVersion).toBe("v3");
  });

  it("reflects cachedInputTokens in trace.totalCachedTokens when onStepFinish reports cache hits", async () => {
    const fakeOrchestrator = { specificationVersion: "v3" as const } as LanguageModel;
    const fakeWorker = { specificationVersion: "v3" as const } as LanguageModel;

    mockGenerate.mockImplementation(async () => {
      const step = {
        toolResults: [{ toolName: "finish", output: "final answer" }],
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: { cacheReadTokens: 80 },
        },
        providerMetadata: {},
      };
      // Invoke onStepFinish from the constructor settings so the trace accumulates cached tokens
      const agent = agentInstances[agentInstances.length - 1]!;
      const onStepFinish = agent.settings.onStepFinish as
        | ((step: unknown) => void | Promise<void>)
        | undefined;
      if (onStepFinish) {
        await onStepFinish(step);
      }
      return {
        text: "done",
        steps: [step],
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: { cacheReadTokens: 80 },
        },
        providerMetadata: {},
      };
    });

    const budge = createBudge({ orchestrator: fakeOrchestrator, worker: fakeWorker });
    const context = await budge.prepare({
      task: "test task",
      sources: { s: makeAdapter() },
    });

    expect(context.trace.totalCachedTokens).toBe(80);
  });

  it("totalCachedTokens is 0 when no cache hits are reported", async () => {
    const fakeOrchestrator = { specificationVersion: "v3" as const } as LanguageModel;
    const fakeWorker = { specificationVersion: "v3" as const } as LanguageModel;

    mockGenerate.mockResolvedValue({
      text: "done",
      steps: [
        {
          toolResults: [{ toolName: "finish", output: "final answer" }],
          usage: {
            inputTokens: 50,
            outputTokens: 10,
            inputTokenDetails: { cacheReadTokens: 0 },
          },
          providerMetadata: {},
        },
      ],
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 0 },
      },
      providerMetadata: {},
    });

    const budge = createBudge({ orchestrator: fakeOrchestrator, worker: fakeWorker });
    const context = await budge.prepare({
      task: "test task",
      sources: { s: makeAdapter() },
    });

    expect(context.trace.totalCachedTokens).toBe(0);
  });
});
