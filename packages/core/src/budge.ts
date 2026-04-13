import type { SourceAdapter } from "./sources/interface.ts";
import type { BudgeOptions, PrepareOptions, PreparedContext } from "./types.ts";
import { buildHandoff, buildFallbackHandoff } from "./handoff.ts";
import { TraceBuilder } from "./trace.ts";
import { runAgent } from "./agent.ts";

/**
 * A Budge instance. Create one with `createBudge()` and reuse it
 * across multiple `prepare()` calls.
 */
export interface Budge {
  /**
   * Prepares context for a task with access to the provided sources.
   *
   * The agent navigates sources lazily — it calls `describe()`, `list()`,
   * and `read()` on your adapters as needed, and can spawn focused sub-calls
   * via `run_subcall` and `run_subcalls`. You never manage context windows.
   *
   * Type inference is automatic: the `sources` keys flow through to
   * `context.trace.sourcesAccessed`, giving you typed keys without casting.
   *
   * @example
   * ```ts
   * const context = await budge.prepare({
   *   task: "summarize the auth module",
   *   sources: {
   *     codebase: source.fs("./src"),
   *     docs: source.files(["./docs/auth.md"]),
   *   },
   * })
   *
   * context.answer                      // string
   * context.handoff                     // string
   * context.trace.sourcesAccessed       // { codebase?: string[], docs?: string[] }
   * context.trace.tree                  // RootTraceNode
   * ```
   */
  prepare<S extends Record<string, SourceAdapter>>(
    options: PrepareOptions<S>,
  ): Promise<PreparedContext<S>>;
}

/**
 * Creates a `@budge/core` Budge instance.
 *
 * Pass a primary orchestrator for the root agent and a worker for focused
 * sub-calls. Both accept any AI SDK-compatible `LanguageModel`.
 *
 * @example
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
 *   task: "refactor the auth module to use JWT",
 *   sources: {
 *     codebase: source.fs("./src"),
 *     docs: source.files(["./docs/auth.md"]),
 *   },
 * })
 *
 * console.log(context.answer)
 * console.log(context.handoff)
 * console.log(context.trace)
 * ```
 */
export function createBudge(options: BudgeOptions): Budge {
  const { orchestrator, worker, concurrency = 5 } = options;
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency));

  return {
    async prepare<S extends Record<string, SourceAdapter>>(
      prepareOptions: PrepareOptions<S>,
    ): Promise<PreparedContext<S>> {
      const { task, sources, onToolCall, maxSteps, subcallSchemas } = prepareOptions;

      const trace = new TraceBuilder<S>(task);

      const { answer, finishReason } = await runAgent({
        orchestrator,
        worker,
        task,
        sources,
        onToolCall,
        maxSteps,
        subcallSchemas,
        concurrency: normalizedConcurrency,
        trace,
      });

      const builtTrace = trace.build();

      let handoff: string;
      let handoffFailed = false;

      try {
        handoff = await buildHandoff({
          task,
          answer,
          trace: builtTrace,
          worker,
        });
      } catch {
        handoff = buildFallbackHandoff({ task, answer, trace: builtTrace });
        handoffFailed = true;
      }

      return {
        task,
        answer,
        handoff,
        handoffFailed,
        finishReason,
        trace: builtTrace,
      };
    },
  };
}
