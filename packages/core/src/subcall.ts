import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { SourceAdapter } from "./sources/interface.ts";
import type { SubcallTraceNode, TokenUsage } from "./types.ts";
import { makeSubcallNode } from "./trace.ts";

/**
 * Options for a focused sub-call.
 * @internal
 */
export interface SubcallOptions {
  /** The sub-model to use (typically a faster, cheaper model). */
  subModel: LanguageModel;
  /** The source adapter to scope this call to. */
  adapter: SourceAdapter;
  /** The source name (for trace labeling). */
  sourceName: string;
  /** The path within the source to focus on. */
  path: string;
  /** The specific sub-task to accomplish. */
  task: string;
}

/**
 * Spawns a focused model call scoped to a specific slice of a source.
 *
 * The sub-call:
 * 1. Attempts `adapter.read(path)` directly (handles slice notation, file paths,
 *    and any addressable path).
 * 2. If the read fails, includes the error in the sub-call context so the root
 *    agent can recover by listing or trying a different path.
 * 3. Assembles a focused prompt with the resolved content
 * 4. Calls the sub-model with no tools (direct answer, no recursion)
 *
 * Returns a SubcallTraceNode that can be added to the root trace.
 *
 * @internal
 */
export async function runSubcall(opts: SubcallOptions): Promise<SubcallTraceNode> {
  const { subModel, adapter, sourceName, path, task } = opts;

  const startMs = Date.now();

  // Step 1: Resolve content at path.
  // Sub-calls operate on one readable path. If the path cannot be read,
  // surface that error to the sub-model instead of silently analyzing
  // unrelated content from a broad list() fallback.
  const contentParts: string[] = [];

  try {
    const direct = await adapter.read(path);
    contentParts.push(`--- ${path} ---\n${direct}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    contentParts.push(`--- ${path} ---\n[Could not read: ${message}]`);
  }

  const content = contentParts.join("\n\n");

  // Step 3: Focused model call
  const result = await generateText({
    model: subModel,
    system: [
      "You are a focused analysis assistant.",
      "You will be given content from a source and a specific task to perform.",
      "Answer the task directly and concisely based only on the provided content.",
      "Do not speculate about content that was not provided.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          `Source: ${sourceName} (path: ${path || "root"})`,
          ``,
          `Task: ${task}`,
          ``,
          `Content:`,
          content,
        ].join("\n"),
      },
    ],
  });

  const usage: TokenUsage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
  };

  return makeSubcallNode({
    source: sourceName,
    path,
    task,
    answer: result.text,
    usage,
    startMs,
  });
}
