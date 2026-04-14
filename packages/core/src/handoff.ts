import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import safeStableStringify from "safe-stable-stringify";
import type { HandoffStructured, RuntimeTrace, SubcallTraceNode, ToolCallRecord } from "./types.ts";

const HANDOFF_SYSTEM_PROMPT = `You turn Budge research output into a briefing for a downstream action agent.
Return a structured object with these exact fields:
- goal: string
- instructions: string[]
- discoveries: string[]
- relevantSources: Array<{ source: string; path: string; note: string }>
- openQuestions: string[]
- confidence: "High" | "Medium" | "Low"
- confidenceRationale: string
Base output on the final answer plus trace evidence. Keep items concrete and source-aware.`;

const handoffStructuredSchema = z.object({
  goal: z.string().min(1),
  instructions: z.array(z.string().min(1)),
  discoveries: z.array(z.string().min(1)),
  relevantSources: z.array(
    z.object({
      source: z.string().min(1),
      path: z.string().min(1),
      note: z.string().min(1),
    }),
  ),
  openQuestions: z.array(z.string().min(1)),
  confidence: z.enum(["High", "Medium", "Low"]),
  confidenceRationale: z.string().min(1),
});

export function renderHandoffMarkdown(structured: HandoffStructured): string {
  const parts: string[] = ["# Context", "", "## Goal", structured.goal];

  if (structured.instructions.length > 0) {
    parts.push("", "## Instructions");
    for (const instruction of structured.instructions) {
      parts.push(`- ${instruction}`);
    }
  }

  parts.push("", "## Discoveries");
  if (structured.discoveries.length > 0) {
    for (const discovery of structured.discoveries) {
      parts.push(`- ${discovery}`);
    }
  } else {
    parts.push("- none");
  }

  if (structured.relevantSources.length > 0) {
    parts.push("", "## Relevant files / paths");
    for (const source of structured.relevantSources) {
      parts.push(`- ${source.source}: ${source.path} - ${source.note}`);
    }
  }

  if (structured.openQuestions.length > 0) {
    parts.push("", "## Open questions");
    for (const question of structured.openQuestions) {
      parts.push(`- ${question}`);
    }
  }

  parts.push("", "## Confidence", `${structured.confidence}. ${structured.confidenceRationale}`);

  return parts.join("\n");
}

export async function buildHandoff(opts: {
  task: string;
  answer: string;
  trace: RuntimeTrace<any>;
  worker: LanguageModel;
  system?: string;
}): Promise<{ structured: HandoffStructured; markdown: string }> {
  const { task, answer, trace, worker } = opts;

  const result = await generateText({
    model: worker,
    system: HANDOFF_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildHandoffInput({ task, answer, trace }) }],
    output: Output.object({ schema: handoffStructuredSchema, name: "handoff_structured" }),
  });

  const structured = result.output;
  const markdown = opts.system
    ? `# System\n${opts.system}\n\n${renderHandoffMarkdown(structured)}`
    : renderHandoffMarkdown(structured);

  return { structured, markdown };
}

function buildHandoffInput(opts: {
  task: string;
  answer: string;
  trace: RuntimeTrace<any>;
}): string {
  const { task, answer, trace } = opts;
  const readPaths = collectReadPaths(trace);
  const listedPaths = collectListedPaths(trace.tree.toolCalls);
  const listedNotRead = collectListedButNotRead(listedPaths, readPaths);
  const subcallsBySource = groupSubcallsBySource(trace.tree.children);
  const totalReadPaths = Array.from(readPaths.values()).reduce((sum, paths) => sum + paths.size, 0);
  const sourceNames = Array.from(new Set([...readPaths.keys(), ...listedPaths.keys()]));

  return [
    "Task:",
    task,
    "",
    "Final answer:",
    answer,
    "",
    "Trace summary:",
    `- Total subcalls: ${trace.totalSubcalls}`,
    `- Total tokens: ${trace.totalTokens}`,
    `- Duration ms: ${trace.durationMs}`,
    `- Sources with observable access: ${sourceNames.length === 0 ? "none" : sourceNames.join(", ")}`,
    "",
    "Coverage hints derived from the trace:",
    `- Files read across sources: ${totalReadPaths}`,
    `- Sources read from: ${readPaths.size}`,
    `- Worker call paths: ${trace.tree.children.length === 0 ? "none" : trace.tree.children.map((child) => `${child.source}/${child.path}`).join(", ")}`,
    `- ${formatListedButNotRead(listedNotRead)}`,
    "",
    "Reads by source:",
    formatSourcePathMap(readPaths),
    "",
    "List results by source:",
    formatSourcePathMap(listedPaths),
    "",
    "Focused worker calls:",
    formatSubcalls(subcallsBySource),
    "",
    "Root tool calls:",
    formatToolCalls(trace.tree.toolCalls),
  ].join("\n");
}

export function buildFallbackHandoff(opts: {
  task: string;
  answer: string;
  trace: RuntimeTrace<any>;
  system?: string;
}): { structured: HandoffStructured; markdown: string } {
  const readPaths = collectReadPaths(opts.trace);
  const totalReadPaths = Array.from(readPaths.values()).reduce((sum, paths) => sum + paths.size, 0);
  const sourceNames = Array.from(readPaths.keys());

  const relevantSources: HandoffStructured["relevantSources"] = [];
  for (const [source, paths] of readPaths) {
    for (const path of paths) {
      relevantSources.push({ source, path, note: "accessed during prepare" });
    }
  }

  const structured: HandoffStructured = {
    goal: opts.task,
    instructions: [],
    discoveries: [truncate(opts.answer, 500) || "No answer captured."],
    relevantSources,
    openQuestions: [],
    confidence: "Medium",
    confidenceRationale: `Generated from trace without worker synthesis. ${totalReadPaths} files read across ${sourceNames.length} sources.`,
  };

  const markdown = opts.system
    ? `# System\n${opts.system}\n\n${renderHandoffMarkdown(structured)}`
    : renderHandoffMarkdown(structured);

  return { structured, markdown };
}

function collectReadPaths(trace: RuntimeTrace<any>): Map<string, Set<string>> {
  const readPaths = new Map<string, Set<string>>();

  for (const [source, paths] of Object.entries(trace.sourcesAccessed)) {
    for (const path of paths ?? []) {
      addPath(readPaths, source, path);
    }
  }

  return readPaths;
}

function collectListedPaths(toolCalls: ToolCallRecord[]): Map<string, Set<string>> {
  const listedPaths = new Map<string, Set<string>>();

  for (const toolCall of toolCalls) {
    if (toolCall.tool !== "list_source") continue;

    const source = getStringArg(toolCall, "source");
    if (!source) continue;

    for (const path of parseListedPaths(toolCall.result)) {
      addPath(listedPaths, source, path);
    }
  }

  return listedPaths;
}

function collectListedButNotRead(
  listedPaths: Map<string, Set<string>>,
  readPaths: Map<string, Set<string>>,
): Map<string, string[]> {
  const listedButNotRead = new Map<string, string[]>();

  for (const [source, paths] of listedPaths) {
    const reads = readPaths.get(source) ?? new Set<string>();
    const remaining = Array.from(paths)
      .filter((path) => !reads.has(path))
      .sort();
    if (remaining.length > 0) {
      listedButNotRead.set(source, remaining);
    }
  }

  return listedButNotRead;
}

function groupSubcallsBySource(children: SubcallTraceNode[]): Map<string, SubcallTraceNode[]> {
  const grouped = new Map<string, SubcallTraceNode[]>();

  for (const child of children) {
    const existing = grouped.get(child.source);
    if (existing) {
      existing.push(child);
      continue;
    }
    grouped.set(child.source, [child]);
  }

  return grouped;
}

function formatSourcePathMap(pathMap: Map<string, Set<string>>): string {
  if (pathMap.size === 0) return "- none";

  return Array.from(pathMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, paths]) => {
      const values = Array.from(paths).sort();
      return `- ${source}: ${values.length === 0 ? "none" : values.join(", ")}`;
    })
    .join("\n");
}

function formatListedButNotRead(listedButNotRead: Map<string, string[]>): string {
  const entries = formatListedButNotReadEntries(listedButNotRead);

  if (!entries) {
    return "Coverage limited to files listed in trace.";
  }

  return `The following were listed but not read: ${entries}`;
}

function formatListedButNotReadEntries(listedButNotRead: Map<string, string[]>): string | null {
  if (listedButNotRead.size === 0) {
    return null;
  }

  return Array.from(listedButNotRead.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, paths]) => `${source}: ${paths.join(", ")}`)
    .join("; ");
}

function formatSubcalls(subcallsBySource: Map<string, SubcallTraceNode[]>): string {
  if (subcallsBySource.size === 0) return "- none";

  return Array.from(subcallsBySource.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, nodes]) => {
      const lines = nodes
        .map(
          (node) =>
            `  - ${node.path}: task=${safeStableStringify(node.task) ?? '""'}, answer=${safeStableStringify(truncate(node.answer, 200)) ?? '""'}`,
        )
        .join("\n");
      return `- ${source}:\n${lines}`;
    })
    .join("\n");
}

function formatToolCalls(toolCalls: ToolCallRecord[]): string {
  const meaningful = toolCalls.filter(
    (toolCall) =>
      toolCall.tool === "run_subcall" ||
      toolCall.tool === "run_subcalls" ||
      toolCall.tool === "finish",
  );

  if (meaningful.length === 0) return "- none";

  return meaningful
    .map((toolCall) => {
      const source = getStringArg(toolCall, "source");
      const path = getStringArg(toolCall, "path");
      const location = source ? `${source}${path ? `/${path}` : ""}` : "n/a";
      return `- ${toolCall.tool} @ ${location}: ${safeStableStringify(truncate(toolCall.result, 200)) ?? '""'}`;
    })
    .join("\n");
}

function parseListedPaths(result: string): string[] {
  const trimmed = result.trim();
  if (
    !trimmed ||
    trimmed === "(empty)" ||
    trimmed.startsWith("[Error listing ") ||
    trimmed.startsWith("[Output truncated.")
  ) {
    return [];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !line.startsWith("[Output truncated."));
}

function getStringArg(toolCall: ToolCallRecord, key: string): string | undefined {
  const value = toolCall.args[key];
  return typeof value === "string" ? value : undefined;
}

function addPath(pathMap: Map<string, Set<string>>, source: string, path: string): void {
  const existing = pathMap.get(source);
  if (existing) {
    existing.add(path);
    return;
  }

  pathMap.set(source, new Set([path]));
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
