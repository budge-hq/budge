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
 * 1. Attempts `adapter.read(path)` directly (handles slice notation, file paths,
 *    and any addressable path). Falls back to `adapter.list(path)` if read throws
 *    (e.g. path is a directory), then reads up to `maxItems` listed entries.
 * 2. Assembles a focused prompt with the resolved content
 * 3. Calls the sub-model with no tools (direct answer, no recursion)
 *
 * Returns a SubcallTraceNode that can be added to the root trace.
 *
 * @internal
 */
export async function runSubcall(opts: SubcallOptions): Promise<SubcallTraceNode> {
  const { subModel, adapter, sourceName, path, task, maxItems = 10 } = opts;

  const startMs = Date.now();

  // Step 1: Resolve content at path.
  // Try a direct read first — this correctly handles addressable paths like
  // slice notation ("80:90"), explicit file paths, and single-item addresses.
  // If read() throws (e.g. path is a directory), fall back to list() so the
  // agent can explore container paths as intended.
  const contentParts: string[] = [];
  let items: string[];

  try {
    const direct = await adapter.read(path);
    contentParts.push(`--- ${path} ---\n${direct}`);
    items = []; // direct read consumed the path; nothing left to list
  } catch {
    try {
      items = await adapter.list(path);
    } catch {
      items = [path]; // last resort: treat path itself as the item
    }
  }

  // Step 2: Read up to maxItems from the listing (skipped if direct read succeeded)
  const toRead = items.slice(0, maxItems);

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
