/**
 * @budge/core — Recursive agent decomposition runtime for context navigation.
 *
 * ## Quick start
 *
 * ```ts
 * import { createBudge, source } from "@budge/core"
 * import { openai } from "@ai-sdk/openai"
 *
 * const budge = createBudge({
 *   orchestrator: openai("gpt-5.4"),
 *   worker: openai("gpt-5.4-mini"),
 * })
 *
 * const context = await budge.prepare({
 *   task: "summarize the auth module and identify security concerns",
 *   sources: {
 *     codebase: source.fs("./src"),
 *     docs: source.files(["./docs/auth.md"]),
 *     history: source.conversation(messages),
 *     notes: source.text("Deployment notes"),
 *   },
 * })
 *
 * console.log(context.answer)
 * console.log(context.handoff)
 * console.log(context.trace)
 * ```
 */

// Budge
export { createBudge } from "./budge.ts";
export type { Budge } from "./budge.ts";
export { withPromptCaching } from "./cache.ts";

// Source adapters
export { source } from "./sources/index.ts";
export type { SourceAdapter } from "./sources/index.ts";
export {
  FsAdapter,
  FilesAdapter,
  ConversationAdapter,
  TextAdapter,
  McpAdapter,
} from "./sources/index.ts";
export { DEFAULT_LIMITS, Truncator } from "./truncation.ts";
export type {
  FsAdapterOptions,
  ConversationMessage,
  McpLikeClient,
  McpSourceOptions,
  ToolDefinition,
} from "./sources/index.ts";
export type { TruncateContext, TruncateOptions, TruncateResult } from "./truncation.ts";

// Types
export type {
  BudgeOptions,
  PrepareOptions,
  RunFinishReason,
  HandoffStructured,
  PreparedContext,
  RuntimeTrace,
  TraceNode,
  RootTraceNode,
  SubcallTraceNode,
  ToolCallEvent,
  ToolCallRecord,
  TokenUsage,
} from "./types.ts";
