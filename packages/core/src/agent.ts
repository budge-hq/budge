import { generateText, hasToolCall, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import type { SourceAdapter } from "./sources/interface.ts";
import type { RunOptions, RunFinishReason, TokenUsage } from "./types.ts";
import { TraceBuilder } from "./trace.ts";
import { buildTools } from "./tools.ts";

/**
 * Options for running the root agent loop.
 * @internal
 */
export interface RunAgentOptions<S extends Record<string, SourceAdapter>> extends Pick<
  RunOptions<S>,
  "task" | "sources" | "onToolCall" | "maxSteps"
> {
  model: LanguageModel;
  subModel: LanguageModel;
  trace: TraceBuilder<S>;
}

/**
 * Runs the root agent loop.
 *
 * The agent receives:
 * - The task
 * - Descriptions of all available sources (no data, just what's there)
 * - History of tool calls and results from previous steps
 * - Four tools: read_source, list_source, run_subcall, finish
 *
 * The loop continues until the agent calls `finish` or `maxSteps` is reached.
 *
 * @returns The agent's answer and how the loop ended.
 * @internal
 */
export async function runAgent<S extends Record<string, SourceAdapter>>(
  opts: RunAgentOptions<S>,
): Promise<{ answer: string; finishReason: RunFinishReason }> {
  const { model, subModel, task, sources, onToolCall, maxSteps = 100, trace } = opts;

  const tools = buildTools({ sources, subModel, trace, onToolCall });

  const sourceDescriptions = buildSourceDescriptions(sources);

  const result = await generateText({
    model,
    system: buildSystemPrompt(sourceDescriptions),
    messages: [{ role: "user", content: task }],
    tools,
    stopWhen: [hasToolCall("finish"), stepCountIs(maxSteps)],
    onStepFinish(step) {
      const usage: TokenUsage = {
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        totalTokens: (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
      };
      trace.addRootUsage(usage);
    },
  });

  // Check whether the agent called finish — walk steps in reverse
  for (let i = result.steps.length - 1; i >= 0; i--) {
    const step = result.steps[i]!;
    for (const toolResult of step.toolResults) {
      if (toolResult.toolName === "finish") {
        const out = toolResult.output;
        return {
          answer: typeof out === "string" ? out : String(out),
          finishReason: "finish",
        };
      }
    }
  }

  // Loop was cut off before finish — return whatever text the model last produced
  return {
    answer: result.text || "",
    finishReason: "max_steps",
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSourceDescriptions<S extends Record<string, SourceAdapter>>(sources: S): string {
  const entries = Object.entries(sources);
  if (entries.length === 0) return "No sources available.";

  return entries.map(([name, adapter]) => `- **${name}**: ${adapter.describe()}`).join("\n");
}

function buildSystemPrompt(sourceDescriptions: string): string {
  return [
    "You are an expert research agent. Your job is to answer a task by intelligently",
    "navigating the available sources.",
    "",
    "## Available sources",
    "",
    sourceDescriptions,
    "",
    "## How to work",
    "",
    "1. Use `list_source` to explore what's available in a source before reading.",
    "2. Use `read_source` to read specific files or items.",
    "3. Use `run_subcall` when you need deeper analysis of a content slice —",
    "   it spawns a focused call with the content in full context.",
    "4. Navigate lazily — only read what you need to answer the task.",
    "5. Once you have enough information, call `finish` with your complete answer.",
    "",
    "## Important",
    "",
    "- Be selective. Don't read everything — read what's relevant.",
    "- `run_subcall` is ideal for summarization, analysis, and comparison tasks",
    "  on a specific file or directory.",
    "- Call `finish` only when you can give a complete, accurate answer.",
    "- Your answer should be well-structured and address the task directly.",
  ].join("\n");
}
