import type {
  ChunkRecord,
  PolicyRecord,
  PromptTrace,
  SourceRecord,
  SourceRecordType,
  Trace,
} from "./types.ts";
import type { SourceTag } from "./types.ts";
import { generateRunId } from "./utils.ts";

export interface SourceTiming {
  key: string;
  type: SourceRecordType;
  tags: SourceTag[];
  resolvedAt: Date;
  durationMs: number;
  itemRecords?: ChunkRecord[];
}

export function buildTrace(options: {
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sourceTimings: SourceTiming[];
  policyRecords: PolicyRecord[];
  derived: Record<string, unknown>;
  budgetMax: number;
  budgetUsed: number;
  strategyName?: string;
  budgetCandidates?: number;
  budgetSelected?: number;
  promptTrace?: PromptTrace;
}): Trace {
  const {
    windowId,
    startedAt,
    completedAt,
    sourceTimings,
    policyRecords,
    derived,
    budgetMax,
    budgetUsed,
    strategyName,
    budgetCandidates,
    budgetSelected,
    promptTrace,
  } = options;

  const sources: SourceRecord[] = sourceTimings.map((t): SourceRecord => {
    const base = {
      key: t.key,
      resolvedAt: t.resolvedAt,
      durationMs: t.durationMs,
      tags: t.tags,
    };
    if (t.type === "rag") {
      return { ...base, type: "rag" as const, items: t.itemRecords ?? [] };
    }
    return { ...base, type: t.type };
  });

  return {
    runId: generateRunId(),
    windowId,
    startedAt,
    completedAt,
    sources,
    policies: policyRecords,
    derived,
    budget: {
      max: budgetMax,
      used: budgetUsed,
      ...(strategyName !== undefined && { strategy: strategyName }),
      ...(budgetCandidates !== undefined && { candidates: budgetCandidates }),
      ...(budgetSelected !== undefined && { selected: budgetSelected }),
    },
    ...(promptTrace !== undefined && { prompt: promptTrace }),
  };
}
