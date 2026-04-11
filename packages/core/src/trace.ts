import type { SourceTag, SourceTrace, ToolCollision, Trace } from "./types.ts";
import { generateRunId } from "./utils.ts";

export interface SourceTiming {
  key: string;
  sourceId: string;
  kind: "input" | "value" | "rag" | "history" | "tools";
  tags: SourceTag[];
  dependsOn: string[];
  completedAt: Date;
  durationMs: number;
  status: "resolved" | "failed";
  estimatedTokens?: number;
  contentLength?: number;
  contentHash?: string;
  itemCount?: number;
  totalMessages?: number;
  includedMessages?: number;
  droppedMessages?: number;
  droppedByKind?: Record<string, number>;
  compactionDroppedMessages?: number;
  strategy?: "sliding";
  maxMessages?: number;
  totalTools?: number;
  includedTools?: number;
  droppedTools?: number;
  toolNames?: string[];
  toolSources?: {
    static: string[];
    mcp: string[];
  };
  toolCollisions?: ToolCollision[];
}

function toSourceTrace(windowId: string, timing: SourceTiming): SourceTrace {
  return {
    key: timing.key,
    fingerprint: `${windowId}:${timing.key}`,
    sourceId: timing.sourceId,
    kind: timing.kind,
    tags: timing.tags,
    dependsOn: timing.dependsOn,
    completedAt: timing.completedAt,
    durationMs: timing.durationMs,
    status: timing.status,
    ...(timing.estimatedTokens !== undefined && { estimatedTokens: timing.estimatedTokens }),
    ...(timing.contentLength !== undefined && { contentLength: timing.contentLength }),
    ...(timing.contentHash !== undefined && { contentHash: timing.contentHash }),
    ...(timing.itemCount !== undefined && { itemCount: timing.itemCount }),
    ...(timing.totalMessages !== undefined && { totalMessages: timing.totalMessages }),
    ...(timing.includedMessages !== undefined && { includedMessages: timing.includedMessages }),
    ...(timing.droppedMessages !== undefined && { droppedMessages: timing.droppedMessages }),
    ...(timing.droppedByKind !== undefined && { droppedByKind: timing.droppedByKind }),
    ...(timing.compactionDroppedMessages !== undefined && {
      compactionDroppedMessages: timing.compactionDroppedMessages,
    }),
    ...(timing.strategy !== undefined && { strategy: timing.strategy }),
    ...(timing.maxMessages !== undefined && { maxMessages: timing.maxMessages }),
    ...(timing.totalTools !== undefined && { totalTools: timing.totalTools }),
    ...(timing.includedTools !== undefined && { includedTools: timing.includedTools }),
    ...(timing.droppedTools !== undefined && { droppedTools: timing.droppedTools }),
    ...(timing.toolNames !== undefined && { toolNames: timing.toolNames }),
    ...(timing.toolSources !== undefined && { toolSources: timing.toolSources }),
    ...(timing.toolCollisions !== undefined && { toolCollisions: timing.toolCollisions }),
  };
}

export function buildTrace(options: {
  windowId: string;
  sessionId?: string;
  turnIndex?: number;
  startedAt: Date;
  completedAt: Date;
  sourceTimings: SourceTiming[];
}): Trace {
  const { windowId, sessionId, turnIndex, startedAt, completedAt, sourceTimings } = options;

  return {
    version: 1,
    runId: generateRunId(),
    ...(sessionId !== undefined && { sessionId }),
    ...(turnIndex !== undefined && { turnIndex }),
    windowId,
    startedAt,
    completedAt,
    sources: sourceTimings.map((timing) => toSourceTrace(windowId, timing)),
  };
}
