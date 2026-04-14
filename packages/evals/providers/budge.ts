/**
 * evals/providers/budge.ts
 *
 * Custom promptfoo provider that runs a task through budge.prepare()
 * and returns the answer + token metadata for scoring.
 *
 * Must be a class — promptfoo calls `new Provider(options)` for file:// providers.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CallApiContextParams, ProviderOptions, ProviderResponse } from "promptfoo";
import type { createBudge as CreateBudge, source as Source } from "@budge/core";

interface BudgeProviderConfig {
  root?: string;
  include?: string[];
  exclude?: string[];
  orchestratorModel?: string;
  workerModel?: string;
  provider?: string;
  maxSteps?: number;
}

export default class BudgeProvider {
  private readonly config: BudgeProviderConfig;
  private readonly providerId: string;

  constructor(options: ProviderOptions) {
    this.config = (options.config ?? {}) as BudgeProviderConfig;
    this.providerId = options.id ?? "budge";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, _context?: CallApiContextParams): Promise<ProviderResponse> {
    const { config } = this;

    const evalDir = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(evalDir, "../../..");
    const sourceRoot = config.root
      ? path.resolve(evalDir, config.root)
      : path.resolve(repoRoot, "packages/core");

    // Import @budge/core — try built dist first, fall back to source
    let createBudge: typeof CreateBudge;
    let source: typeof Source;

    try {
      const mod = await import(
        pathToFileURL(path.resolve(repoRoot, "packages/core/dist/index.mjs")).href
      );
      createBudge = mod.createBudge;
      source = mod.source;
    } catch {
      const mod = await import(
        pathToFileURL(path.resolve(repoRoot, "packages/core/src/index.ts")).href
      );
      createBudge = mod.createBudge;
      source = mod.source;
    }

    const orchestratorModel =
      config.orchestratorModel ?? process.env.BUDGE_ORCHESTRATOR ?? "claude-sonnet-4-6";
    const workerModel =
      config.workerModel ?? process.env.BUDGE_WORKER ?? "claude-haiku-4-5-20251001";
    const providerName = config.provider ?? process.env.BUDGE_PROVIDER ?? "anthropic";

    let orchestrator: Parameters<typeof CreateBudge>[0]["orchestrator"];
    let worker: Parameters<typeof CreateBudge>[0]["worker"];

    if (providerName === "anthropic") {
      const { anthropic } = await import("@ai-sdk/anthropic");
      orchestrator = anthropic(orchestratorModel);
      worker = anthropic(workerModel);
    } else {
      const { openai } = await import("@ai-sdk/openai");
      orchestrator = openai(orchestratorModel);
      worker = openai(workerModel);
    }

    const budge = createBudge({ orchestrator, worker });

    const fsOptions: Parameters<typeof Source.fs>[1] = {};
    if (config.include) fsOptions.include = config.include;
    if (config.exclude) fsOptions.exclude = config.exclude;

    const startMs = Date.now();
    let toolCallCount = 0;
    const toolCallLog: string[] = [];

    try {
      const result = await budge.prepare({
        task: prompt,
        sources: {
          codebase: source.fs(sourceRoot, fsOptions),
        },
        maxSteps: config.maxSteps ?? 60,
        onToolCall: (event) => {
          const label =
            event.tool === "read_source" || event.tool === "run_subcall"
              ? `${event.tool} → ${event.args.source}/${event.args.path}`
              : event.tool === "run_subcalls"
                ? `run_subcalls → ${event.args.calls.length} calls`
                : event.tool;
          toolCallLog.push(`[${toolCallCount++}] ${label}`);
        },
      });

      const wallMs = Date.now() - startMs;

      return {
        output: result.answer,
        latencyMs: wallMs,
        tokenUsage: {
          total: result.trace.totalTokens,
          prompt: result.trace.tree.usage.inputTokens,
          completion: result.trace.tree.usage.outputTokens,
        },
        metadata: {
          totalTokens: result.trace.totalTokens,
          totalSubcalls: result.trace.totalSubcalls,
          durationMs: wallMs,
          finishReason: result.finishReason,
          sourcesAccessed: result.trace.sourcesAccessed,
          handoffFailed: result.handoffFailed,
          toolCallCount,
          toolCallLog: toolCallLog,
          handoff: result.handoff,
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
