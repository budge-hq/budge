import type { LanguageModel } from "ai";
import type { SourceAdapter } from "./sources/interface.ts";

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/**
 * Options for creating a runtime instance.
 *
 * Both `model` and `subModel` accept any AI SDK-compatible model provider,
 * keeping @budge/core decoupled from any specific provider.
 *
 * @example
 * ```ts
 * import { anthropic } from "@ai-sdk/anthropic"
 *
 * const runtime = createRuntime({
 *   model: anthropic("claude-sonnet-4-6"),
 *   subModel: anthropic("claude-haiku-4-5"),
 * })
 * ```
 */
export interface RuntimeOptions {
  /**
   * The primary model used for the root agent loop.
   * Should be a capable, instruction-following model.
   */
  model: LanguageModel;

  /**
   * The model used for focused sub-calls.
   * Typically a faster, cheaper model — sub-calls are narrow tasks.
   */
  subModel: LanguageModel;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/**
 * Options passed to `runtime.run()`.
 *
 * @typeParam S - The sources map type. Inferred from the `sources` argument —
 *               you never need to specify this manually.
 */
export interface RunOptions<
  S extends Record<string, SourceAdapter> = Record<string, SourceAdapter>,
> {
  /**
   * The task for the root agent to accomplish.
   *
   * Be specific. The agent uses this to decide which sources to explore
   * and what to delegate to sub-calls.
   *
   * @example "Summarize the auth module and identify any security concerns"
   */
  task: string;

  /**
   * Named sources available to the agent.
   *
   * The agent receives descriptions of all sources upfront. It navigates
   * them lazily — only reading what it determines is relevant to the task.
   *
   * Keys become the source names the agent references in tool calls.
   */
  sources: S;

  /**
   * Called on every tool invocation during the agent loop.
   *
   * Use this to stream progress, log decisions, or build a live UI.
   * The callback receives a discriminated union — `switch` on `event.tool`
   * to get typed `args` for each tool.
   *
   * @example
   * ```ts
   * onToolCall: (event) => {
   *   if (event.tool === "run_subcall") {
   *     console.log(`Sub-call: ${event.args.task} (${event.args.source}/${event.args.path})`)
   *   }
   * }
   * ```
   */
  onToolCall?: (event: ToolCallEvent) => void;

  /**
   * Maximum number of agent steps before the loop is forcibly stopped.
   *
   * A "step" is one round-trip to the model. Default: 30.
   * Raise this for complex tasks, lower it for cost control.
   */
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Tool call events (discriminated union)
// ---------------------------------------------------------------------------

/**
 * A tool invocation event emitted to the `onToolCall` callback.
 *
 * Narrowing on `event.tool` gives you fully typed `event.args`:
 *
 * ```ts
 * switch (event.tool) {
 *   case "read_source":  event.args.path   // string
 *   case "list_source":  event.args.path   // string | undefined
 *   case "run_subcall":  event.args.task   // string
 *   case "finish":       event.args.answer // string
 * }
 * ```
 */
export type ToolCallEvent =
  | { tool: "read_source"; args: { source: string; path: string } }
  | { tool: "list_source"; args: { source: string; path?: string } }
  | { tool: "run_subcall"; args: { source: string; path: string; task: string } }
  | { tool: "finish"; args: { answer: string } };

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  /** Total input (prompt) tokens consumed. */
  inputTokens: number;
  /** Total output (completion) tokens consumed. */
  outputTokens: number;
  /** Sum of inputTokens + outputTokens. */
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Trace types
// ---------------------------------------------------------------------------

/**
 * A record of a single tool call made during the root agent loop.
 */
export interface ToolCallRecord {
  /** The tool that was called. */
  tool: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** The result returned by the tool (serialized as string). */
  result: string;
  /** Wall time for this tool call in milliseconds. */
  durationMs: number;
}

/**
 * A node in the decomposition tree.
 *
 * The tree has exactly one root node and zero or more subcall nodes.
 * Each subcall node represents a focused model call spawned by `run_subcall`.
 */
export type TraceNode = RootTraceNode | SubcallTraceNode;

/**
 * The root agent node — the top-level model call that drove the task.
 */
export interface RootTraceNode {
  type: "root";
  /** The task given to the runtime. */
  task: string;
  /** Token usage for the root agent across all steps. */
  usage: TokenUsage;
  /** Wall time for the entire root agent loop in milliseconds. */
  durationMs: number;
  /** Every tool call made by the root agent, in order. */
  toolCalls: ToolCallRecord[];
  /** Sub-calls spawned by the root agent via `run_subcall`. */
  children: SubcallTraceNode[];
}

/**
 * A focused sub-call spawned by `run_subcall`.
 */
export interface SubcallTraceNode {
  type: "subcall";
  /** The sub-task the sub-call was given. */
  task: string;
  /** The source name the sub-call was scoped to. */
  source: string;
  /** The path within the source the sub-call was focused on. */
  path: string;
  /** The answer the sub-call returned. */
  answer: string;
  /** Token usage for this sub-call. */
  usage: TokenUsage;
  /** Wall time for this sub-call in milliseconds. */
  durationMs: number;
}

/**
 * The full trace of a `runtime.run()` call.
 *
 * @typeParam S - The sources map type passed to `run()`. Provides typed keys
 *               in `sourcesAccessed` so you know exactly which of your named
 *               sources were read — no string guessing.
 */
export interface RuntimeTrace<
  S extends Record<string, SourceAdapter> = Record<string, SourceAdapter>,
> {
  /** Total number of sub-calls spawned by the root agent. */
  totalSubcalls: number;

  /** Total tokens consumed across all model calls (root + all sub-calls). */
  totalTokens: number;

  /** Total wall time from `run()` invocation to result, in milliseconds. */
  durationMs: number;

  /**
   * Which paths were read from each source.
   *
   * Keys are the source names you passed in `sources`. This is typed as
   * `Partial` because not every source is necessarily accessed.
   */
  sourcesAccessed: Partial<Record<keyof S & string, string[]>>;

  /**
   * The full decomposition tree. The root node contains all tool call records
   * and the list of sub-call children.
   */
  tree: RootTraceNode;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The result of a `runtime.run()` call.
 *
 * @typeParam S - The sources map type. Inferred automatically.
 */
export interface RuntimeResult<
  S extends Record<string, SourceAdapter> = Record<string, SourceAdapter>,
> {
  /** The agent's final answer to the task. */
  answer: string;

  /** Full trace of everything that happened during the run. */
  trace: RuntimeTrace<S>;
}
