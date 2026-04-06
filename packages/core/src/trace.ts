import type { PromptTrace, SourceTag, SourceTrace, Trace } from "./types.ts";
import { generateRunId } from "./utils.ts";

export interface SourceTiming {
  sourceId: string;
  kind: "value" | "rag";
  tags: SourceTag[];
  resolvedAt: Date;
  durationMs: number;
  itemCount?: number;
}

function toSourceTrace(timing: SourceTiming): SourceTrace {
  return {
    sourceId: timing.sourceId,
    kind: timing.kind,
    tags: timing.tags,
    resolvedAt: timing.resolvedAt,
    durationMs: timing.durationMs,
    ...(timing.itemCount !== undefined && { itemCount: timing.itemCount }),
  };
}

export function buildTrace(options: {
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sourceTimings: SourceTiming[];
  budgetMax: number;
  budgetUsed: number;
  budgetExceeded: boolean;
  prompt: PromptTrace;
}): Trace {
  const {
    windowId,
    startedAt,
    completedAt,
    sourceTimings,
    budgetMax,
    budgetUsed,
    budgetExceeded,
    prompt,
  } = options;

  return {
    version: 1,
    runId: generateRunId(),
    windowId,
    startedAt,
    completedAt,
    sources: sourceTimings.map(toSourceTrace),
    budget: {
      max: Number.isFinite(budgetMax) ? budgetMax : null,
      used: budgetUsed,
      exceeded: budgetExceeded,
    },
    prompt,
  };
}
