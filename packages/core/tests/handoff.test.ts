import type { LanguageModel } from "ai";
import { generateText } from "ai";
import safeStableStringify from "safe-stable-stringify";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as agentModule from "../src/agent.ts";
import { createBudge } from "../src/budge.ts";
import * as handoffModule from "../src/handoff.ts";
import { buildFallbackHandoff, buildHandoff } from "../src/handoff.ts";
import { Truncator } from "../src/truncation.ts";
import type { RuntimeTrace } from "../src/types.ts";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

const mockGenerateText = vi.mocked(generateText);
const orchestrator = {} as LanguageModel;
const worker = {} as LanguageModel;
const longSubcallAnswer = `AUTH_ANALYSIS ${"x".repeat(260)}`;

function makeTrace(): RuntimeTrace<any> {
  return {
    totalSubcalls: 1,
    totalTokens: 42,
    durationMs: 120,
    totalCachedTokens: 0,
    sourcesAccessed: {
      codebase: ["src/auth.ts"],
      history: ["thread/123"],
    },
    tree: {
      type: "root",
      task: "Review auth flows",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: 0,
      },
      durationMs: 120,
      toolCalls: [
        {
          tool: "list_source",
          args: { source: "codebase", path: "src" },
          result: "src/auth.ts\nsrc/legacy/",
          durationMs: 3,
        },
        {
          tool: "read_source",
          args: { source: "codebase", path: "src/auth.ts" },
          result: "export async function login() {}",
          durationMs: 5,
        },
        {
          tool: "list_source",
          args: { source: "history" },
          result: "thread/123",
          durationMs: 2,
        },
        {
          tool: "read_source",
          args: { source: "history", path: "thread/123" },
          result: "User reported intermittent login failures.",
          durationMs: 2,
        },
      ],
      children: [
        {
          type: "subcall",
          source: "codebase",
          path: "src/auth.ts",
          task: "Summarize the login flow",
          answer: longSubcallAnswer,
          usage: {
            inputTokens: 6,
            outputTokens: 6,
            totalTokens: 12,
            cachedInputTokens: 0,
          },
          durationMs: 20,
        },
      ],
    },
  };
}

function makeTraceWithMeaningfulToolCalls(): RuntimeTrace<any> {
  const trace = makeTrace();

  return {
    ...trace,
    tree: {
      ...trace.tree,
      toolCalls: [
        ...trace.tree.toolCalls,
        {
          tool: "run_subcall",
          args: {
            source: "codebase",
            path: "src/auth.ts",
            task: "Summarize the login flow",
          },
          result: "Focused summary of the login flow.",
          durationMs: 11,
        },
        {
          tool: "finish",
          args: {
            answer: "Prepared auth analysis.",
          },
          result: "Prepared auth analysis.",
          durationMs: 1,
        },
      ],
    },
  };
}

function makeAdapter() {
  return {
    describe: () => "fixture source",
    list: vi.fn(async () => []),
    read: vi.fn(async (path: string) => `contents for ${path}`),
  };
}

function promptText(value: unknown): string {
  if (typeof value === "string") return value;
  return safeStableStringify(value) ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildHandoff()", () => {
  it("returns a non-empty string containing the task", async () => {
    mockGenerateText.mockImplementation(async (args) => {
      const prompt = promptText(args.messages?.[0]?.content);

      expect(prompt).toContain("Review auth flows");
      expect(prompt).toContain("AUTH_ANALYSIS");
      expect(prompt).not.toContain(longSubcallAnswer);

      return {
        text: [
          "# Context",
          "",
          "## Task",
          "Review auth flows",
          "",
          "## Findings",
          "### codebase",
          "- src/auth.ts: Handles the login flow and session transitions.",
          "",
          "## Coverage",
          "2 files read across 2 sources. Worker calls covered: codebase/src/auth.ts. The following were listed but not read: codebase: src/legacy/.",
          "",
          "## Confidence",
          "High. The final answer matches the traced reads and worker analysis.",
        ].join("\n"),
        usage: { inputTokens: 5, outputTokens: 7 },
      } as Awaited<ReturnType<typeof generateText>>;
    });

    const handoff = await buildHandoff({
      task: "Review auth flows",
      answer: "The auth module coordinates login state and session handling.",
      trace: makeTrace(),
      worker,
    });

    expect(handoff).toContain("# Context");
    expect(handoff).toContain("Review auth flows");
    expect(handoff.trim().length).toBeGreaterThan(0);
  });

  it("passes source names from the trace into the worker prompt", async () => {
    mockGenerateText.mockResolvedValue({
      text: "# Context\n\n## Task\nReview auth flows\n\n## Findings\n### codebase\n- src/auth.ts: summary\n\n## Coverage\nCoverage limited to files listed in trace.\n\n## Confidence\nMedium. Limited trace.",
      usage: { inputTokens: 3, outputTokens: 4 },
    } as Awaited<ReturnType<typeof generateText>>);

    await buildHandoff({
      task: "Review auth flows",
      answer: "The auth module coordinates login state and session handling.",
      trace: makeTrace(),
      worker,
    });

    const request = mockGenerateText.mock.calls[0]?.[0];
    const prompt = promptText(request?.messages?.[0]?.content);

    expect(prompt).toContain("codebase");
    expect(prompt).toContain("history");
  });

  it("returns markdown as a string, not JSON", async () => {
    mockGenerateText.mockResolvedValue({
      text: "# Context\n\n## Task\nReview auth flows\n\n## Findings\n### codebase\n- src/auth.ts: summary\n\n## Coverage\nCoverage limited to files listed in trace.\n\n## Confidence\nMedium. Limited trace.",
      usage: { inputTokens: 2, outputTokens: 3 },
    } as Awaited<ReturnType<typeof generateText>>);

    const handoff = await buildHandoff({
      task: "Review auth flows",
      answer: "The auth module coordinates login state and session handling.",
      trace: makeTrace(),
      worker,
    });

    expect(typeof handoff).toBe("string");
    expect(handoff.trim().startsWith("{")).toBe(false);
  });

  describe("buildFallbackHandoff()", () => {
    it("does not start with a blank line when system is omitted", () => {
      const handoff = buildFallbackHandoff({
        task: "Review auth flows",
        answer: "Prepared auth analysis.",
        trace: makeTrace(),
      });

      expect(handoff.startsWith("\n")).toBe(false);
      expect(handoff.startsWith("# Context")).toBe(true);
    });
  });

  it("only includes meaningful tool calls in the worker prompt", async () => {
    mockGenerateText.mockImplementation(async (args) => {
      const prompt = promptText(args.messages?.[0]?.content);

      expect(prompt).toContain("Root tool calls:");
      expect(prompt).toContain("run_subcall @ codebase/src/auth.ts");
      expect(prompt).toContain("finish @ n/a");
      expect(prompt).not.toContain("read_source @ codebase/src/auth.ts");
      expect(prompt).not.toContain("list_source @ codebase/src");

      return {
        text: "# Context\n\n## Task\nReview auth flows\n\n## Findings\n### codebase\n- src/auth.ts: summary\n\n## Coverage\nCoverage limited to files listed in trace.\n\n## Confidence\nMedium. Limited trace.",
        usage: { inputTokens: 3, outputTokens: 4 },
      } as Awaited<ReturnType<typeof generateText>>;
    });

    await buildHandoff({
      task: "Review auth flows",
      answer: "The auth module coordinates login state and session handling.",
      trace: makeTraceWithMeaningfulToolCalls(),
      worker,
    });
  });
});

describe("createBudge().prepare()", () => {
  it("returns PreparedContext with handoff populated", async () => {
    vi.spyOn(agentModule, "runAgent").mockResolvedValue({
      answer: "Prepared auth analysis.",
      finishReason: "finish",
    });
    mockGenerateText.mockResolvedValue({
      text: "# Context\n\n## Task\nReview auth flows\n\n## Findings\n### codebase\n- src/auth.ts: summary\n\n## Coverage\nCoverage limited to files listed in trace.\n\n## Confidence\nMedium. Limited trace.",
      usage: { inputTokens: 4, outputTokens: 6 },
    } as Awaited<ReturnType<typeof generateText>>);

    const budge = createBudge({ orchestrator, worker });
    const context = await budge.prepare({
      task: "Review auth flows",
      sources: { codebase: makeAdapter() },
    });

    expect(context.task).toBe("Review auth flows");
    expect(context.answer).toBe("Prepared auth analysis.");
    expect(context.handoff).toContain("# Context");
    expect(typeof context.handoff).toBe("string");
    expect(context.handoffFailed).toBe(false);
  });

  it("sets handoffFailed and returns the fallback handoff when synthesis fails", async () => {
    vi.spyOn(agentModule, "runAgent").mockResolvedValue({
      answer: "Prepared auth analysis.",
      finishReason: "finish",
    });
    vi.spyOn(handoffModule, "buildHandoff").mockRejectedValueOnce(new Error("worker exploded"));

    const budge = createBudge({ orchestrator, worker });
    const context = await budge.prepare({
      task: "Review auth flows",
      sources: { codebase: makeAdapter() },
    });

    expect(context.handoff).toBe(
      buildFallbackHandoff({
        task: "Review auth flows",
        answer: "Prepared auth analysis.",
        trace: context.trace,
      }),
    );
    expect(context.handoffFailed).toBe(true);
  });

  it("sets handoffFailed when the worker returns empty handoff text", async () => {
    vi.spyOn(agentModule, "runAgent").mockResolvedValue({
      answer: "Prepared auth analysis.",
      finishReason: "finish",
    });
    mockGenerateText.mockResolvedValue({
      text: "   ",
      usage: { inputTokens: 4, outputTokens: 0 },
    } as Awaited<ReturnType<typeof generateText>>);

    const budge = createBudge({ orchestrator, worker });
    const context = await budge.prepare({
      task: "Review auth flows",
      sources: { codebase: makeAdapter() },
    });

    expect(context.handoff).toBe(
      buildFallbackHandoff({
        task: "Review auth flows",
        answer: "Prepared auth analysis.",
        trace: context.trace,
      }),
    );
    expect(context.handoffFailed).toBe(true);
  });

  it("runs one cleanup per prepare call without creating timers", async () => {
    const cleanupSpy = vi.spyOn(Truncator.prototype, "cleanup").mockResolvedValue(undefined);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    vi.spyOn(agentModule, "runAgent").mockResolvedValue({
      answer: "Prepared auth analysis.",
      finishReason: "finish",
    });
    vi.spyOn(handoffModule, "buildHandoff").mockResolvedValue("briefing");

    const budge = createBudge({ orchestrator, worker });

    await budge.prepare({
      task: "Review auth flows",
      sources: { codebase: makeAdapter() },
    });
    await budge.prepare({
      task: "Review auth flows again",
      sources: { codebase: makeAdapter() },
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
