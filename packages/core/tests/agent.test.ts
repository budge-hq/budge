import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runAgent } from "../src/agent.ts";
import { TraceBuilder } from "../src/trace.ts";
import { Truncator } from "../src/truncation.ts";

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

function asGenerateTextResult(value: unknown): Awaited<ReturnType<typeof generateText>> {
  return value as Awaited<ReturnType<typeof generateText>>;
}

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
    mockGenerateText.mockResolvedValue(
      asGenerateTextResult({
        text: "ignored",
        steps: [
          {
            toolResults: [{ toolName: "finish", output: "final answer" }],
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );

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
    mockGenerateText.mockResolvedValue(
      asGenerateTextResult({
        text: "partial answer",
        steps: [{ toolResults: [] }, { toolResults: [] }],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );

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
    mockGenerateText.mockResolvedValue(
      asGenerateTextResult({
        text: "model ended without finish tool",
        steps: [{ toolResults: [] }],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );

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
