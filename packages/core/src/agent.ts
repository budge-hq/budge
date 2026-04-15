import { ToolLoopAgent, hasToolCall, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import type { SourceAdapter } from "./sources/interface.ts";
import type { Truncator } from "./truncation.ts";
import type { PrepareOptions, RunFinishReason, TokenUsage } from "./types.ts";
import { TraceBuilder } from "./trace.ts";
import { buildTools } from "./tools.ts";
import { extractCachedTokens } from "./cache.ts";

/**
 * Options for running the root agent loop.
 * @internal
 */
export interface RunAgentOptions<S extends Record<string, SourceAdapter>> extends Pick<
  PrepareOptions<S>,
  "task" | "sources" | "onToolCall" | "maxSteps" | "subcallSchemas"
> {
  orchestrator: LanguageModel;
  worker: LanguageModel;
  concurrency: number;
  trace: TraceBuilder<S>;
  truncator: Truncator;
}

/**
 * Runs the root agent loop.
 *
 * The agent receives:
 * - The task
 * - Descriptions of all available sources (no data, just what's there)
 * - History of tool calls and results from previous steps
 * - Five tools: read_source, list_source, run_subcall, run_subcalls, finish
 *
 * The loop continues until the agent calls `finish` or `maxSteps` is reached.
 *
 * @returns The agent's answer and how the loop ended.
 * @internal
 */
export async function runAgent<S extends Record<string, SourceAdapter>>(
  opts: RunAgentOptions<S>,
): Promise<{ answer: string; finishReason: RunFinishReason }> {
  const {
    orchestrator,
    worker,
    task,
    sources,
    onToolCall,
    maxSteps = 100,
    subcallSchemas,
    concurrency,
    trace,
    truncator,
  } = opts;

  const tools = buildTools({
    sources,
    worker,
    trace,
    onToolCall,
    subcallSchemas,
    concurrency,
    truncator,
  });

  const sourceDescriptions = buildSourceDescriptions(sources);

  const sourceValues = Object.values(sources) as SourceAdapter[];
  const capabilities: SourceCapabilities = {
    hasAnyList: sourceValues.some((s) => s.list != null),
    hasAnyRead: sourceValues.some((s) => s.read != null),
    hasAnySearch: sourceValues.some((s) => s.search != null),
  };

  const agent = new ToolLoopAgent({
    model: orchestrator,
    instructions: buildSystemPrompt(sourceDescriptions, capabilities),
    tools,
    stopWhen: [hasToolCall("finish"), stepCountIs(maxSteps)],
    onStepFinish(step) {
      const cachedInputTokens = extractCachedTokens(step.providerMetadata, step.usage);
      const usage: TokenUsage = {
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        totalTokens: (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
        cachedInputTokens,
      };
      trace.addRootUsage(usage);
    },
  });

  const result = await agent.generate({ prompt: task });

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

  // No finish tool call — classify whether the loop hit maxSteps.
  const hitStepLimit = result.steps.length >= maxSteps;

  return {
    answer: result.text || "",
    finishReason: hitStepLimit ? "max_steps" : "no_finish",
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

/**
 * Which content-access methods are available across all registered sources.
 * Controls which tool instructions appear in the system prompt.
 * @internal
 */
export interface SourceCapabilities {
  hasAnyList: boolean;
  hasAnyRead: boolean;
  hasAnySearch: boolean;
}

export function buildSystemPrompt(
  sourceDescriptions: string,
  capabilities: SourceCapabilities,
): string {
  const { hasAnyList, hasAnyRead, hasAnySearch } = capabilities;
  const hasSubcalls = hasAnyRead; // run_subcall requires read()

  // "How to work" — numbered steps, only for tools that exist.
  // stepNum increments once per logical step so numbering is always contiguous
  // regardless of which capabilities are present.
  const steps: string[] = [];
  let stepNum = 0;
  const n = () => `${++stepNum}.`;

  if (hasAnyList) {
    steps.push(
      `${n()} Use \`list_source\` to explore what's available in a source before reading.`,
    );
  }
  if (hasAnyRead) {
    steps.push(`${n()} Use \`read_source\` to read specific files or items.`);
  }
  if (hasAnySearch) {
    steps.push(
      `${n()} Use \`search_source\` to find relevant content by query when a source supports it.`,
      "   Issue MULTIPLE narrow searches rather than one broad query for better results.",
      ...(hasSubcalls
        ? ["   Use chunk IDs returned by search with `run_subcall` for deeper analysis."]
        : []),
    );
  }
  if (hasSubcalls) {
    steps.push(
      `${n()} Use \`run_subcall\` when you need deeper analysis of a content slice —`,
      "   it spawns a focused call with the content in full context.",
      `${n()} Use \`run_subcalls\` when you need to analyze multiple independent paths simultaneously.`,
      "   It runs focused calls in parallel and is much faster than sequential single sub-calls.",
    );
  }
  steps.push(
    `${n()} Navigate lazily — only read what you need to answer the task.`,
    `${n()} Once you have enough information, call \`finish\` with your complete answer.`,
  );

  // Worked examples — only include examples for tools that are registered
  const examples: string[] = [];
  if (hasAnySearch && hasSubcalls) {
    examples.push(
      "Example — search then focused analysis:",
      '  Step 1: search_source({source: "notes", query: {text: "insulin dosage", k: 3}})',
      '        → [{id: "chunk:4", ...}, {id: "chunk:11", ...}, ...]',
      '  Step 2: run_subcalls([{source: "notes", path: "chunk:4", task: "..."},',
      '                        {source: "notes", path: "chunk:11", task: "..."}])  ← parallel',
      "  Step 3: finish(...)",
    );
  }
  if (hasAnyList && hasAnyRead) {
    examples.push(
      "Example — parallel reads after a single list:",
      '  Step 1: list_source({source: "docs"}) → ["intro.md", "api.md", "changelog.md"]',
      '  Step 2: read_source({source: "docs", path: "intro.md"})',
      '        + read_source({source: "docs", path: "api.md"})',
      '        + read_source({source: "docs", path: "changelog.md"})  ← all three in one response',
      "  Step 3: finish(...)",
    );
  }

  // "## Important" bullets — only mention tools that exist
  const importantBullets = [
    "- Be selective. Don't read everything — read what's relevant.",
    ...(hasSubcalls
      ? [
          "- `run_subcall` is ideal for summarization, analysis, and comparison tasks",
          "  on a specific file or directory.",
          "- Prefer `run_subcalls` over repeated sequential `run_subcall` calls when the sub-tasks are independent.",
          "  Sequential single sub-calls for independent work are an antipattern.",
        ]
      : []),
    "- Once you have enough information, call `finish` immediately. Do not continue",
    "  exploring after you have enough to answer. A good answer based on what you've",
    "  read is better than an incomplete loop.",
    "- Your answer should be well-structured and address the task directly.",
  ];

  // "## Parallelism" examples — gated by tool availability
  const parallelismBullets = [
    ...(hasAnyRead
      ? [
          "- Reading three files to answer one question? Issue three `read_source` calls",
          "  in one response, not three separate responses.",
        ]
      : []),
    ...(hasAnyList
      ? [
          "- Listing two sources to compare them? Issue both `list_source` calls in one",
          "  response.",
        ]
      : []),
    ...(hasAnyRead && hasAnyList
      ? [
          "- Already know which paths you want from a previous list? Read them all in",
          "  parallel, not one at a time.",
        ]
      : []),
  ];

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
    ...steps,
    ...(examples.length > 0 ? ["", ...examples] : []),
    "",
    "## Important",
    "",
    ...importantBullets,
    ...(parallelismBullets.length > 0
      ? [
          "",
          "## Parallelism",
          "",
          "You can call multiple tools in a single response. ALWAYS prefer to do so when",
          "the calls are independent. Examples:",
          "",
          ...parallelismBullets,
          "",
          "Sequential single tool calls when the work is independent is an antipattern",
          "and roughly halves your effective throughput.",
        ]
      : []),
  ].join("\n");
}
