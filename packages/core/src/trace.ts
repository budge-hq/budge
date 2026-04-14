import type { SourceAdapter } from "./sources/interface.ts";
import type {
  RootTraceNode,
  RuntimeTrace,
  SubcallTraceNode,
  ToolCallRecord,
  TokenUsage,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Mutable builder — internal only
// ---------------------------------------------------------------------------

/**
 * Mutable trace accumulator used during a `budge.prepare()` call.
 * Sealed into an immutable `RuntimeTrace` by `buildTrace()`.
 *
 * @internal
 */
export class TraceBuilder<S extends Record<string, SourceAdapter>> {
  private readonly startMs: number;
  private readonly task: string;
  private rootUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private readonly toolCalls: ToolCallRecord[] = [];
  private readonly subcalls: SubcallTraceNode[] = [];
  private readonly accessed: Map<string, Set<string>> = new Map();

  constructor(task: string) {
    this.task = task;
    this.startMs = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Mutation methods (called by agent.ts)
  // ---------------------------------------------------------------------------

  recordToolCall(record: ToolCallRecord): void {
    this.toolCalls.push(record);
  }

  recordRead(source: string, path: string): void {
    if (!this.accessed.has(source)) {
      this.accessed.set(source, new Set());
    }
    this.accessed.get(source)!.add(path);
  }

  recordSubcall(node: SubcallTraceNode): void {
    this.subcalls.push(node);
    this.recordRead(node.source, node.path);
  }

  addRootUsage(usage: TokenUsage): void {
    this.rootUsage = addUsage(this.rootUsage, usage);
  }

  // ---------------------------------------------------------------------------
  // Seal
  // ---------------------------------------------------------------------------

  build(): RuntimeTrace<S> {
    const durationMs = Date.now() - this.startMs;

    const rootNode: RootTraceNode = {
      type: "root",
      task: this.task,
      usage: { ...this.rootUsage },
      durationMs,
      toolCalls: [...this.toolCalls],
      children: [...this.subcalls],
    };

    const totalSubcallTokens = this.subcalls.reduce((sum, s) => sum + s.usage.totalTokens, 0);
    const totalTokens = this.rootUsage.totalTokens + totalSubcallTokens;

    const sourcesAccessed: Partial<Record<keyof S & string, string[]>> = {};
    for (const [source, paths] of this.accessed) {
      (sourcesAccessed as Record<string, string[]>)[source] = [...paths];
    }

    return {
      totalSubcalls: this.subcalls.length,
      totalTokens,
      durationMs,
      sourcesAccessed,
      tree: rootNode,
    };
  }
}

// ---------------------------------------------------------------------------
// Helper for building subcall trace nodes
// ---------------------------------------------------------------------------

export function makeSubcallNode(opts: {
  source: string;
  path: string;
  task: string;
  answer: string;
  structured?: unknown;
  schemaName?: string;
  usage: TokenUsage;
  startMs: number;
  parallel?: boolean;
  truncated?: boolean;
  overflowPath?: string;
}): SubcallTraceNode {
  return {
    type: "subcall",
    source: opts.source,
    path: opts.path,
    task: opts.task,
    answer: opts.answer,
    structured: opts.structured,
    schemaName: opts.schemaName,
    usage: opts.usage,
    durationMs: Date.now() - opts.startMs,
    parallel: opts.parallel,
    truncated: opts.truncated,
    overflowPath: opts.overflowPath,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
