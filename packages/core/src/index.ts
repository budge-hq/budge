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
 *     notes: source.text("Deployment notes: ..."),
 *     // Plain objects work for anything else:
 *     // db: { describe: () => "...", tools: () => postgresTools(prisma) },
 *     // precedent: { describe: () => "...", search: async (q) => vectorSearch(q) },
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

// Source factories + types
export { source } from "./sources/index.ts";
export type { SourceAdapter, SearchQuery, SearchMatch } from "./sources/index.ts";
export { FsAdapter } from "./sources/index.ts";
export { text as textSource, json as jsonSource } from "./sources/index.ts";
export type { FsAdapterOptions, TextSourceOptions, Chunk } from "./sources/index.ts";

// Truncation utilities
export { DEFAULT_LIMITS, Truncator } from "./truncation.ts";
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
  ContributedToolEvents,
  ToolCallRecord,
  TokenUsage,
} from "./types.ts";
