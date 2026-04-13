/**
 * @budge/core — Recursive agent decomposition runtime for context navigation.
 *
 * ## Quick start
 *
 * ```ts
 * import { createRuntime, source } from "@budge/core"
 * import { openai } from "@ai-sdk/openai"
 *
 * const runtime = createRuntime({
 *   model: openai("gpt-5.4"),
 *   subModel: openai("gpt-5.4-mini"),
 * })
 *
 * const result = await runtime.run({
 *   task: "summarize the auth module and identify security concerns",
 *   sources: {
 *     codebase: source.fs("./src"),
 *     docs: source.files(["./docs/auth.md"]),
 *     history: source.conversation(messages),
 *   },
 * })
 *
 * console.log(result.answer)
 * console.log(result.trace)
 * ```
 */

// Runtime
export { createRuntime } from "./runtime.ts";
export type { Runtime } from "./runtime.ts";

// Source adapters
export { source } from "./sources/index.ts";
export type { SourceAdapter } from "./sources/index.ts";
export { FsAdapter, FilesAdapter, ConversationAdapter } from "./sources/index.ts";
export type { FsAdapterOptions, ConversationMessage } from "./sources/index.ts";

// Types
export type {
  RuntimeOptions,
  RunOptions,
  RunFinishReason,
  RuntimeResult,
  RuntimeTrace,
  TraceNode,
  RootTraceNode,
  SubcallTraceNode,
  ToolCallEvent,
  ToolCallRecord,
  TokenUsage,
} from "./types.ts";
