import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import type { ZodType } from "zod";
import safeStableStringify from "safe-stable-stringify";
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
  /** Optional schema for structured output. */
  schema?: ZodType;
  /** Optional schema name for trace labeling. */
  schemaName?: string;
}

export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];

  const normalizedLimit = Math.max(1, Math.floor(limit));
  const results: T[] = [];
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(normalizedLimit, tasks.length) }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= tasks.length) return;
        results[currentIndex] = await tasks[currentIndex]!();
      }
    }),
  );

  return results;
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
  const { subModel, adapter, sourceName, path, task, schema, schemaName } = opts;

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

  // Step 2: Focused model call
  const basePrompt = {
    model: subModel,
    system: [
      "You are a focused analysis assistant.",
      "You will be given content from a source and a specific task to perform.",
      "Answer the task directly and concisely based only on the provided content.",
      "Do not speculate about content that was not provided.",
    ].join(" "),
    messages: [
      {
        role: "user" as const,
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
  };

  if (schema) {
    const result = await generateText({
      ...basePrompt,
      output: Output.object({ schema, name: schemaName }),
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
      answer: safeStableStringify(result.output) ?? "",
      structured: result.output,
      schemaName,
      usage,
      startMs,
    });
  }

  const result = await generateText(basePrompt);

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
