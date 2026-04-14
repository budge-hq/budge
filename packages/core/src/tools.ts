import { tool } from "ai";
import safeStableStringify from "safe-stable-stringify";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ZodType } from "zod";
import type { SourceAdapter } from "./sources/interface.ts";
import type { TraceBuilder } from "./trace.ts";
import type { SubcallTraceNode, ToolCallEvent } from "./types.ts";
import { makeSubcallNode } from "./trace.ts";
import { runConcurrent, runSubcall } from "./subcall.ts";
import { DEFAULT_LIMITS, Truncator } from "./truncation.ts";

/**
 * Options for building the agent tool set.
 * @internal
 */
export interface BuildToolsOptions<S extends Record<string, SourceAdapter>> {
  sources: S;
  worker: LanguageModel;
  trace: TraceBuilder<S>;
  onToolCall?: (event: ToolCallEvent) => void;
  subcallSchemas?: Record<string, ZodType>;
  concurrency?: number;
  truncator?: Truncator;
}

/**
 * Builds the five agent tools and wires them to the live sources + trace.
 *
 * The tools are:
 * - `read_source`  — read a specific path from a named source
 * - `list_source`  — list items at an optional path in a named source
 * - `run_subcall`  — spawn a focused worker call on a content slice
 * - `run_subcalls` — spawn focused worker calls on multiple independent slices
 * - `finish`       — return the final answer and stop the loop
 *
 * @internal
 */
export function buildTools<S extends Record<string, SourceAdapter>>(opts: BuildToolsOptions<S>) {
  const {
    sources,
    worker,
    trace,
    onToolCall,
    subcallSchemas,
    concurrency = 5,
    truncator = new Truncator(),
  } = opts;
  const hasSubcalls = true;

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

        const truncated = await truncator.apply(
          result,
          {
            maxLines: DEFAULT_LIMITS.READ_MAX_LINES,
            maxBytes: DEFAULT_LIMITS.READ_MAX_BYTES,
            direction: "head",
          },
          { toolName: "read_source", hasSubcalls },
        );

        trace.recordRead(source, path);
        trace.recordToolCall({
          tool: "read_source",
          args: { source, path },
          result: truncated.content,
          durationMs: Date.now() - startMs,
          truncated: truncated.truncated,
          overflowPath: truncated.overflowPath,
        });

        return truncated.content;
      },
    }),

    list_source: tool({
      description: [
        "List items available at an optional path within a named source.",
        "Omit path to list the root of the source.",
        "Returns a list of navigable paths or identifiers.",
        "Use these paths with read_source, run_subcall, or run_subcalls.",
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

        let result: { content: string; truncated: boolean; overflowPath?: string };
        try {
          const items = await adapter.list(path);
          result = await truncator.applyArray(
            items,
            DEFAULT_LIMITS.LIST_MAX_ENTRIES,
            formatListItems,
            { toolName: "list_source", hasSubcalls, itemType: "entries" },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = await truncator.apply(
            `[Error listing ${source}/${path ?? ""}: ${message}]`,
            { direction: "head" },
            { toolName: "list_source", hasSubcalls },
          );
        }

        trace.recordToolCall({
          tool: "list_source",
          args: { source, path },
          result: result.content,
          durationMs: Date.now() - startMs,
          truncated: result.truncated,
          overflowPath: result.overflowPath,
        });

        return result.content;
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
        schemaName: z
          .string()
          .optional()
          .describe("Optional structured output schema name registered on budge.prepare()"),
      }),
      execute: async ({ source, path, task, schemaName }) => {
        const startMs = Date.now();
        const adapter = resolveSource(sources, source);
        const schema = schemaName ? resolveSubcallSchema(subcallSchemas, schemaName) : undefined;
        const subcallArgs = schemaName
          ? { source, path, task, schemaName }
          : { source, path, task };

        onToolCall?.({ tool: "run_subcall", args: subcallArgs });

        const subcallNode = await runSubcall({
          worker,
          adapter,
          sourceName: source,
          path,
          task,
          schema,
          schemaName,
        });

        const tracedSubcallNode = await truncateSubcallNode(
          truncator,
          subcallNode,
          "run_subcall",
          hasSubcalls,
        );

        trace.recordSubcall(tracedSubcallNode);
        trace.recordToolCall({
          tool: "run_subcall",
          args: subcallArgs,
          result: tracedSubcallNode.answer,
          durationMs: Date.now() - startMs,
          truncated: tracedSubcallNode.truncated,
          overflowPath: tracedSubcallNode.overflowPath,
        });

        return tracedSubcallNode.answer;
      },
    }),

    run_subcalls: tool({
      description: [
        "Spawn focused analyses on multiple independent slices of sources.",
        "This runs sub-calls in parallel with a bounded concurrency limit.",
        "Use this instead of sequential run_subcall calls when the tasks do not depend on each other.",
        "Each call should point to a single readable item or addressable slice, not a directory listing.",
      ].join(" "),
      inputSchema: z.object({
        calls: z
          .array(
            z.object({
              source: z.string().describe("The source name"),
              path: z.string().describe("The path within the source to focus the sub-call on"),
              task: z
                .string()
                .describe(
                  "A specific, self-contained task for the sub-call to accomplish. " +
                    "Use this only for independent sub-tasks that can run in parallel.",
                ),
              schemaName: z
                .string()
                .optional()
                .describe("Optional structured output schema name registered on budge.prepare()"),
            }),
          )
          .min(1)
          .describe("Independent sub-calls to execute in parallel."),
      }),
      execute: async ({ calls }) => {
        const startMs = Date.now();

        const adapters = calls.map(({ source }) => resolveSource(sources, source));
        const schemas = calls.map(({ schemaName }) =>
          schemaName ? resolveSubcallSchema(subcallSchemas, schemaName) : undefined,
        );

        onToolCall?.({ tool: "run_subcalls", args: { calls } });

        const subcallNodes = await runConcurrent(
          calls.map((call, index) => async () => {
            const startMs = Date.now();

            try {
              const node = await runSubcall({
                worker,
                adapter: adapters[index]!,
                sourceName: call.source,
                path: call.path,
                task: call.task,
                schema: schemas[index],
                schemaName: call.schemaName,
              });

              return truncateSubcallNode(
                truncator,
                { ...node, parallel: true },
                `run_subcalls[${index}]`,
                hasSubcalls,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return makeSubcallNode({
                source: call.source,
                path: call.path,
                task: call.task,
                answer: `[Error: ${message}]`,
                schemaName: call.schemaName,
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                startMs,
                parallel: true,
              });
            }
          }),
          concurrency,
        );

        for (const node of subcallNodes) {
          trace.recordSubcall(node);
        }

        const result = subcallNodes.map((node) => ({
          source: node.source,
          path: node.path,
          task: node.task,
          answer: node.answer,
        }));

        trace.recordToolCall({
          tool: "run_subcalls",
          args: { calls },
          result: safeStableStringify(result) ?? "[]",
          durationMs: Date.now() - startMs,
          truncated: false,
        });

        return result;
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

async function truncateSubcallNode(
  truncator: Truncator,
  node: SubcallTraceNode,
  toolName: string,
  hasSubcalls: boolean,
): Promise<SubcallTraceNode> {
  const truncated = await truncator.apply(
    node.answer,
    {
      maxBytes: DEFAULT_LIMITS.SUBCALL_MAX_BYTES,
      direction: "tail",
    },
    { toolName, hasSubcalls },
  );

  if (!truncated.truncated) {
    return node;
  }

  return {
    ...node,
    answer: truncated.content,
    truncated: true,
    overflowPath: truncated.overflowPath,
  };
}

function formatListItems(items: string[]): string {
  return items.length === 0 ? "(empty)" : items.join("\n");
}

function resolveSubcallSchema(schemas: Record<string, ZodType> | undefined, name: string): ZodType {
  const schema = schemas?.[name];
  if (!schema) {
    const available = Object.keys(schemas ?? {}).join(", ");
    throw new Error(`Unknown subcall schema: "${name}". Available schemas: ${available}`);
  }
  return schema;
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
