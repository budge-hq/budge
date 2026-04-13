import { tool } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { SourceAdapter } from "./sources/interface.ts";
import type { TraceBuilder } from "./trace.ts";
import type { ToolCallEvent } from "./types.ts";
import { runSubcall } from "./subcall.ts";

/**
 * Options for building the agent tool set.
 * @internal
 */
export interface BuildToolsOptions<S extends Record<string, SourceAdapter>> {
  sources: S;
  subModel: LanguageModel;
  trace: TraceBuilder<S>;
  onToolCall?: (event: ToolCallEvent) => void;
}

/**
 * Builds the four agent tools and wires them to the live sources + trace.
 *
 * The tools are:
 * - `read_source`  — read a specific path from a named source
 * - `list_source`  — list items at an optional path in a named source
 * - `run_subcall`  — spawn a focused sub-model call on a content slice
 * - `finish`       — return the final answer and stop the loop
 *
 * @internal
 */
export function buildTools<S extends Record<string, SourceAdapter>>(opts: BuildToolsOptions<S>) {
  const { sources, subModel, trace, onToolCall } = opts;

  return {
    read_source: tool({
      description: [
        "Read the content at a specific path within a named source.",
        "Use list_source first to discover what paths are available.",
        "Returns the raw content as a string.",
      ].join(" "),
      inputSchema: z.object({
        source: z.string().describe("The source name (one of the keys in your sources map)"),
        path: z.string().describe("The path within the source to read"),
      }),
      execute: async ({ source, path }) => {
        const startMs = Date.now();
        const adapter = resolveSource(sources, source);

        onToolCall?.({ tool: "read_source", args: { source, path } });

        let result: string;
        try {
          result = await adapter.read(path);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = `[Error reading ${source}/${path}: ${message}]`;
        }

        trace.recordRead(source, path);
        trace.recordToolCall({
          tool: "read_source",
          args: { source, path },
          result,
          durationMs: Date.now() - startMs,
        });

        return result;
      },
    }),

    list_source: tool({
      description: [
        "List items available at an optional path within a named source.",
        "Omit path to list the root of the source.",
        "Returns a list of navigable paths or identifiers.",
        "Use these paths with read_source or run_subcall.",
      ].join(" "),
      inputSchema: z.object({
        source: z.string().describe("The source name"),
        path: z
          .string()
          .optional()
          .describe("Optional sub-path to list. Omit for the root listing."),
      }),
      execute: async ({ source, path }) => {
        const startMs = Date.now();
        const adapter = resolveSource(sources, source);

        onToolCall?.({ tool: "list_source", args: { source, path } });

        let result: string;
        try {
          const items = await adapter.list(path);
          result = items.length === 0 ? "(empty)" : items.join("\n");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = `[Error listing ${source}/${path ?? ""}: ${message}]`;
        }

        trace.recordToolCall({
          tool: "list_source",
          args: { source, path },
          result,
          durationMs: Date.now() - startMs,
        });

        return result;
      },
    }),

    run_subcall: tool({
      description: [
        "Spawn a focused analysis on a specific slice of a source.",
        "This is more powerful than read_source for complex sub-tasks —",
        "it uses a dedicated model call with the content in full context.",
        "The path should point to a single readable item or addressable slice,",
        "not a directory listing.",
        "Use this when you need synthesis, comparison, or deeper analysis",
        "of content at a particular path.",
      ].join(" "),
      inputSchema: z.object({
        source: z.string().describe("The source name"),
        path: z.string().describe("The path within the source to focus the sub-call on"),
        task: z
          .string()
          .describe(
            "A specific, self-contained task for the sub-call to accomplish. " +
              "Be precise — the sub-call only sees the content at this readable path.",
          ),
      }),
      execute: async ({ source, path, task }) => {
        const adapter = resolveSource(sources, source);

        onToolCall?.({ tool: "run_subcall", args: { source, path, task } });

        const subcallNode = await runSubcall({
          subModel,
          adapter,
          sourceName: source,
          path,
          task,
        });

        trace.recordSubcall(subcallNode);
        trace.recordToolCall({
          tool: "run_subcall",
          args: { source, path, task },
          result: subcallNode.answer,
          durationMs: subcallNode.durationMs,
        });

        return subcallNode.answer;
      },
    }),

    finish: tool({
      description: [
        "Return your final answer to the user's task and end the session.",
        "Call this only when you have enough information to give a complete answer.",
        "Do not call this prematurely — explore the sources as needed first.",
      ].join(" "),
      inputSchema: z.object({
        answer: z
          .string()
          .describe(
            "Your complete, well-formed answer to the original task. " +
              "Write as if speaking directly to the user.",
          ),
      }),
      execute: async ({ answer }) => {
        const startMs = Date.now();
        onToolCall?.({ tool: "finish", args: { answer } });
        trace.recordToolCall({
          tool: "finish",
          args: { answer },
          result: answer,
          durationMs: Date.now() - startMs,
        });
        return answer;
      },
    }),
  } as const;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resolveSource<S extends Record<string, SourceAdapter>>(
  sources: S,
  name: string,
): SourceAdapter {
  const adapter = sources[name as keyof S];
  if (!adapter) {
    const available = Object.keys(sources).join(", ");
    throw new Error(`Unknown source: "${name}". Available sources: ${available}`);
  }
  return adapter;
}
