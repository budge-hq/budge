import type { SourceTag, SourceTrace, Trace } from "./types.ts";
import { generateRunId } from "./utils.ts";

export interface SourceTiming {
  key: string;
  sourceId: string;
  kind: "input" | "value" | "rag";
  tags: SourceTag[];
  dependsOn: string[];
  completedAt: Date;
  durationMs: number;
  status: "resolved" | "failed";
  itemCount?: number;
}

function toSourceTrace(timing: SourceTiming): SourceTrace {
  return {
    key: timing.key,
    sourceId: timing.sourceId,
    kind: timing.kind,
    tags: timing.tags,
    dependsOn: timing.dependsOn,
    completedAt: timing.completedAt,
    durationMs: timing.durationMs,
    status: timing.status,
    ...(timing.itemCount !== undefined && { itemCount: timing.itemCount }),
  };
}

export function buildTrace(options: {
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sourceTimings: SourceTiming[];
}): Trace {
  const { windowId, startedAt, completedAt, sourceTimings } = options;

  return {
    version: 1,
    runId: generateRunId(),
    windowId,
    startedAt,
    completedAt,
    sources: sourceTimings.map(toSourceTrace),
  };
}
