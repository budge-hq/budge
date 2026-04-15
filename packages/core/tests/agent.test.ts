import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runAgent } from "../src/agent.ts";
import { TraceBuilder } from "../src/trace.ts";
import { Truncator } from "../src/truncation.ts";

const { mockGenerate } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    ToolLoopAgent: class MockToolLoopAgent {
      constructor(public settings: Record<string, unknown>) {}
      generate = mockGenerate;
    },
  };
});

const orchestrator = {} as LanguageModel;
const worker = {} as LanguageModel;

function makeAdapter() {
  return {
    describe: () => "fixture source",
    list: vi.fn(async () => []),
    read: vi.fn(async (path: string) => `contents for ${path}`),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runAgent() finish reason classification", () => {
  it("returns finish when finish tool is called", async () => {
    mockGenerate.mockResolvedValue({
      text: "ignored",
      steps: [
        {
          toolResults: [{ toolName: "finish", output: "final answer" }],
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await runAgent({
      orchestrator,
      worker,
      task: "Summarize auth module",
      sources: { codebase: makeAdapter() },
      maxSteps: 60,
      trace: new TraceBuilder("Summarize auth module"),
      concurrency: 5,
      truncator: new Truncator({ enabled: false }),
    });

    expect(result.finishReason).toBe("finish");
    expect(result.answer).toBe("final answer");
  });

  it("returns max_steps when finish is missing and step count reached maxSteps", async () => {
    mockGenerate.mockResolvedValue({
      text: "partial answer",
      steps: [{ toolResults: [] }, { toolResults: [] }],
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await runAgent({
      orchestrator,
      worker,
      task: "Summarize auth module",
      sources: { codebase: makeAdapter() },
      maxSteps: 2,
      trace: new TraceBuilder("Summarize auth module"),
      concurrency: 5,
      truncator: new Truncator({ enabled: false }),
    });

    expect(result.finishReason).toBe("max_steps");
    expect(result.answer).toBe("partial answer");
  });

  it("returns no_finish when finish is missing and step count is below maxSteps", async () => {
    mockGenerate.mockResolvedValue({
      text: "model ended without finish tool",
      steps: [{ toolResults: [] }],
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await runAgent({
      orchestrator,
      worker,
      task: "Summarize auth module",
      sources: { codebase: makeAdapter() },
      maxSteps: 60,
      trace: new TraceBuilder("Summarize auth module"),
      concurrency: 5,
      truncator: new Truncator({ enabled: false }),
    });

    expect(result.finishReason).toBe("no_finish");
    expect(result.answer).toBe("model ended without finish tool");
  });
});
