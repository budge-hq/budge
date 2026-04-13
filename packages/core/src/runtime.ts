import type { SourceAdapter } from "./sources/interface.ts";
import type { RuntimeOptions, RunOptions, RuntimeResult } from "./types.ts";
import { TraceBuilder } from "./trace.ts";
import { runAgent } from "./agent.ts";

/**
 * A runtime instance. Create one with `createRuntime()` and reuse it
 * across multiple `run()` calls.
 */
export interface Runtime {
  /**
   * Runs the agent on a task with access to the provided sources.
   *
   * The agent navigates sources lazily — it calls `describe()`, `list()`,
   * and `read()` on your adapters as needed, and can spawn focused sub-calls
   * via `run_subcall`. You never manage context windows.
   *
   * Type inference is automatic: the `sources` keys flow through to
   * `result.trace.sourcesAccessed`, giving you typed keys without casting.
   *
   * @example
   * ```ts
   * const result = await runtime.run({
   *   task: "summarize the auth module",
   *   sources: {
   *     codebase: source.fs("./src"),
   *     docs: source.files(["./docs/auth.md"]),
   *   },
   * })
   *
   * result.answer                       // string
   * result.trace.sourcesAccessed        // { codebase?: string[], docs?: string[] }
   * result.trace.tree                   // RootTraceNode
   * ```
   */
  run<S extends Record<string, SourceAdapter>>(options: RunOptions<S>): Promise<RuntimeResult<S>>;
}

/**
 * Creates a `@budge/core` runtime.
 *
 * Pass a primary model for the root agent and a sub-model for focused
 * sub-calls. Both accept any AI SDK-compatible `LanguageModel`.
 *
 * @example
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
 *   task: "refactor the auth module to use JWT",
 *   sources: {
 *     codebase: source.fs("./src"),
 *     docs: source.files(["./docs/auth.md"]),
 *   },
 * })
 *
 * console.log(result.answer)
 * console.log(result.trace)
 * ```
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { model, subModel } = options;

  return {
    async run<S extends Record<string, SourceAdapter>>(
      runOptions: RunOptions<S>,
    ): Promise<RuntimeResult<S>> {
      const { task, sources, onToolCall, maxSteps } = runOptions;

      const trace = new TraceBuilder<S>(task);

      const { answer, finishReason } = await runAgent({
        model,
        subModel,
        task,
        sources,
        onToolCall,
        maxSteps,
        trace,
      });

      return {
        answer,
        finishReason,
        trace: trace.build(),
      };
    },
  };
}
