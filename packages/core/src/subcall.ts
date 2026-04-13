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
  /** Maximum number of items to read in a single sub-call. Default: 10. */
  maxItems?: number;
}

/**
 * Spawns a focused model call scoped to a specific slice of a source.
 *
 * The sub-call:
 * 1. Lists what's available at `path` within the source
 * 2. Reads up to `maxItems` items from that listing
 * 3. Assembles a focused prompt with the content
 * 4. Calls the sub-model with no tools (direct answer, no recursion)
 *
 * Returns a SubcallTraceNode that can be added to the root trace.
 *
 * @internal
 */
export async function runSubcall(opts: SubcallOptions): Promise<SubcallTraceNode> {
  const { subModel, adapter, sourceName, path, task, maxItems = 10 } = opts;

  const startMs = Date.now();

  // Step 1: Enumerate what's available at the path
  let items: string[];
  try {
    items = await adapter.list(path);
  } catch {
    items = [path]; // Fall back to treating path itself as the item
  }

  // Step 2: Read up to maxItems
  const toRead = items.slice(0, maxItems);
  const contentParts: string[] = [];

  for (const item of toRead) {
    try {
      const content = await adapter.read(item);
      contentParts.push(`--- ${item} ---\n${content}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      contentParts.push(`--- ${item} ---\n[Error reading: ${message}]`);
    }
  }

  const omitted = items.length - toRead.length;
  if (omitted > 0) {
    contentParts.push(`\n[${omitted} additional item${omitted === 1 ? "" : "s"} omitted]`);
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
