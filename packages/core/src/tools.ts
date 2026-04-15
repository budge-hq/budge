import { tool } from "ai";
import safeStableStringify from "safe-stable-stringify";
import { z } from "zod";
import type { InferToolInput, InferToolOutput, LanguageModel, Tool } from "ai";
import type { ZodType } from "zod";
import type { SearchQuery, SourceAdapter } from "./sources/interface.ts";
import type { TraceBuilder } from "./trace.ts";
import type { SubcallTraceNode, ToolCallEvent } from "./types.ts";
import { makeSubcallNode } from "./trace.ts";
import { runConcurrent, runSubcall } from "./subcall.ts";
import { DEFAULT_LIMITS, Truncator } from "./truncation.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>;

/**
 * Options for building the agent tool set.
 * @internal
 */
export interface BuildToolsOptions<S extends Record<string, SourceAdapter>> {
  sources: S;
  worker: LanguageModel;
  trace: TraceBuilder<S>;
  onToolCall?: (event: ToolCallEvent<S>) => void;
  subcallSchemas?: Record<string, ZodType>;
  concurrency?: number;
  truncator?: Truncator;
}

// ---------------------------------------------------------------------------
// Zod schema for SearchQuery (shared between buildTools and agent.ts)
// ---------------------------------------------------------------------------

const searchQuerySchema = z.object({
  text: z.string().min(1).describe("Natural language description of what to find."),
  k: z.number().int().min(1).max(50).default(5).describe("How many results to return."),
  filters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Source-specific metadata filters. Check the source description for available filter keys.",
    ),
});

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

/**
 * Builds the orchestrator's tool set from all sources.
 *
 * Standard content tools (`list_source`, `read_source`, `search_source`) are
 * registered only when at least one source supports the corresponding method.
 * Source-contributed tools are namespaced by source name (e.g. `db.runQuery`).
 * `run_subcall`, `run_subcalls`, and `finish` are always registered.
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
  const hasSubcalls = true; // all agents currently support subcalls

  const sourceEntries = Object.entries(sources) as Array<[string, SourceAdapter]>;

  const hasAnyList = sourceEntries.some(([, s]) => s.list != null);
  const hasAnyRead = sourceEntries.some(([, s]) => s.read != null);
  const hasAnySearch = sourceEntries.some(([, s]) => s.search != null);

  // ---------------------------------------------------------------------------
  // Dynamic descriptions — embed per-source capability notes
  // ---------------------------------------------------------------------------

  function buildListDescription(): string {
    const supports = sourceEntries.filter(([, s]) => s.list != null).map(([n]) => n);
    const unsupported = sourceEntries
      .filter(([, s]) => s.list == null)
      .map(([n, s]) => {
        if (s.search) return `${n} (search-only — use search_source)`;
        if (s.tools) return `${n} (tools-only — use ${n}.* tools)`;
        return n;
      });

    const lines = [
      "List items available at an optional path within a named source.",
      "Omit path to list the root of the source.",
      "Returns a list of navigable paths or identifiers.",
      "Use these paths with read_source, run_subcall, or run_subcalls.",
      "Issue parallel calls in one response when calls are independent.",
      "",
      `Sources that support list: ${supports.join(", ")}`,
    ];
    if (unsupported.length > 0) {
      lines.push(`Sources that do NOT support list: ${unsupported.join(", ")}`);
    }
    return lines.join("\n");
  }

  function buildReadDescription(): string {
    const supports = sourceEntries.filter(([, s]) => s.read != null).map(([n]) => n);
    const unsupported = sourceEntries
      .filter(([, s]) => s.read == null)
      .map(([n, s]) => {
        if (s.search) return `${n} (search-only — use search_source)`;
        if (s.tools) return `${n} (tools-only — use ${n}.* tools)`;
        return n;
      });

    const lines = [
      "Read the content at a specific path within a named source.",
      "Use list_source first to discover what paths are available.",
      "Returns the raw content as a string.",
      "Issue parallel calls in one response when reads are independent.",
      "",
      `Sources that support read: ${supports.join(", ")}`,
    ];
    if (unsupported.length > 0) {
      lines.push(`Sources that do NOT support read: ${unsupported.join(", ")}`);
    }
    return lines.join("\n");
  }

  function buildSearchDescription(): string {
    const supports = sourceEntries
      .filter(([, s]) => s.search != null)
      .map(([n, s]) => `${n}: ${s.describe()}`);
    const unsupported = sourceEntries
      .filter(([, s]) => s.search == null)
      .map(([n, s]) => {
        if (s.read) return `${n} (use read_source or list_source)`;
        if (s.tools) return `${n} (use ${n}.* tools)`;
        return n;
      });

    const lines = [
      "Search a source by semantic or relevance query.",
      "Returns ranked matches with content, score, and metadata.",
      "",
    ];

    lines.push("Sources that support search:");
    for (const s of supports) lines.push(`  - ${s}`);

    if (unsupported.length > 0) {
      lines.push("");
      lines.push("Sources that do NOT support search:");
      for (const s of unsupported) lines.push(`  - ${s}`);
    }

    lines.push(
      "",
      "Issue MULTIPLE searches rather than one broad query when the task has multiple aspects.",
      "Narrower queries produce better results.",
    );

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Standard content tools (conditionally registered)
  // ---------------------------------------------------------------------------

  const contentTools: Record<string, AnyTool> = {};

  if (hasAnyList) {
    contentTools.list_source = tool({
      description: buildListDescription(),
      inputSchema: z.object({
        source: z.string().describe("The source name"),
        path: z
          .string()
          .optional()
          .describe("Optional sub-path to list. Omit for the root listing."),
      }),
      execute: async ({ source, path }) => {
        const startMs = Date.now();
        const adapter = resolveSourceForMethod(sources, source, "list");

        onToolCall?.({ tool: "list_source", args: { source, path } });

        let result: { content: string; truncated: boolean; overflowPath?: string };
        try {
          const items = await adapter.list!(path);
          result = await truncator.applyArray(
            items,
            DEFAULT_LIMITS.LIST_MAX_ENTRIES,
            formatListItems,
            { toolName: "list_source", hasSubcalls, itemType: "entries" },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            content: `[Error listing ${source}/${path ?? ""}: ${message}]`,
            truncated: false,
          };
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
    });
  }

  if (hasAnyRead) {
    contentTools.read_source = tool({
      description: buildReadDescription(),
      inputSchema: z.object({
        source: z.string().describe("The source name"),
        path: z.string().describe("The path within the source to read"),
      }),
      execute: async ({ source, path }) => {
        const startMs = Date.now();
        const adapter = resolveSourceForMethod(sources, source, "read");

        onToolCall?.({ tool: "read_source", args: { source, path } });

        let result: { content: string; truncated: boolean; overflowPath?: string };
        try {
          const content = await adapter.read!(path);
          result = await truncator.apply(
            content,
            {
              maxLines: DEFAULT_LIMITS.READ_MAX_LINES,
              maxCharsPerLine: DEFAULT_LIMITS.READ_MAX_CHARS_PER_LINE,
              maxBytes: DEFAULT_LIMITS.READ_MAX_BYTES,
              direction: "head",
            },
            { toolName: "read_source", hasSubcalls },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = { content: `[Error reading ${source}/${path}: ${message}]`, truncated: false };
        }

        trace.recordRead(source, path);
        trace.recordToolCall({
          tool: "read_source",
          args: { source, path },
          result: result.content,
          durationMs: Date.now() - startMs,
          truncated: result.truncated,
          overflowPath: result.overflowPath,
        });

        return result.content;
      },
    });
  }

  if (hasAnySearch) {
    contentTools.search_source = tool({
      description: buildSearchDescription(),
      inputSchema: z.object({
        source: z.string().describe("The source name"),
        query: searchQuerySchema,
      }),
      execute: async ({ source, query }) => {
        const startMs = Date.now();
        const adapter = resolveSourceForMethod(sources, source, "search");
        const searchQuery: SearchQuery = {
          text: query.text,
          k: query.k,
          filters: query.filters,
        };

        onToolCall?.({ tool: "search_source", args: { source, query: searchQuery } });

        let result: { content: string; truncated: boolean; overflowPath?: string };
        try {
          const matches = await adapter.search!(searchQuery);
          result = await truncator.applyArray(
            matches,
            searchQuery.k,
            (items) => safeStableStringify(items) ?? "[]",
            { toolName: "search_source", hasSubcalls, itemType: "matches" },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = { content: `[Error searching ${source}: ${message}]`, truncated: false };
        }

        trace.recordToolCall({
          tool: "search_source",
          args: { source, query: searchQuery },
          result: result.content,
          durationMs: Date.now() - startMs,
          truncated: result.truncated,
          overflowPath: result.overflowPath,
        });

        return result.content;
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Source-contributed tools (namespaced by source name)
  // ---------------------------------------------------------------------------

  const sourceTools: Record<string, AnyTool> = {};

  for (const [name, source] of sourceEntries) {
    if (source.tools) {
      const contributed = source.tools();
      for (const [toolName, t] of Object.entries(contributed)) {
        const qualifiedName = `${name}.${toolName}`;
        const original = t as AnyTool;
        sourceTools[qualifiedName] = tool({
          ...original,
          execute: async (
            args: InferToolInput<typeof original>,
            ctx: Parameters<NonNullable<AnyTool["execute"]>>[1],
          ) => {
            const startMs = Date.now();
            // Cast: qualifiedName is a string literal at runtime but the type system
            // can't statically verify it matches a specific ContributedToolEvents variant.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onToolCall?.({ tool: qualifiedName, args: args as Record<string, unknown> } as any);
            const result: InferToolOutput<typeof original> = await original.execute?.(args, ctx);
            trace.recordToolCall({
              tool: qualifiedName,
              args: args as Record<string, unknown>,
              result: typeof result === "string" ? result : (safeStableStringify(result) ?? ""),
              durationMs: Date.now() - startMs,
            });
            return result;
          },
        }) as AnyTool;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in tools (always present)
  // ---------------------------------------------------------------------------

  const builtinTools = {
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
        let adapter: SourceAdapter;
        let schema: ZodType | undefined;
        try {
          adapter = resolveSourceForMethod(sources, source, "read");
          schema = schemaName ? resolveSubcallSchema(subcallSchemas, schemaName) : undefined;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `[Error: ${message}]`;
        }
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

        onToolCall?.({ tool: "run_subcalls", args: { calls } });

        const subcallNodes = await runConcurrent(
          calls.map((call, index) => async () => {
            const startMs = Date.now();

            try {
              const adapter = resolveSourceForMethod(sources, call.source, "read");
              const schema = call.schemaName
                ? resolveSubcallSchema(subcallSchemas, call.schemaName)
                : undefined;

              const node = await runSubcall({
                worker,
                adapter,
                sourceName: call.source,
                path: call.path,
                task: call.task,
                schema,
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
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 },
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

  return {
    ...contentTools,
    ...sourceTools,
    ...builtinTools,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function truncateSubcallNode(
  truncator: Truncator,
  node: SubcallTraceNode,
  toolName: string,
  hasSubcalls: boolean,
): Promise<SubcallTraceNode> {
  if (node.schemaName) {
    const bytes = Buffer.byteLength(node.answer, "utf8");
    if (bytes <= DEFAULT_LIMITS.SUBCALL_MAX_BYTES) {
      return node;
    }

    return {
      ...node,
      answer: `[Structured subcall "${node.schemaName}" output exceeded ${DEFAULT_LIMITS.SUBCALL_MAX_BYTES} bytes (${bytes} bytes). Narrow the task or schema.]`,
      truncated: true,
      overflowPath: undefined,
    };
  }

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

/**
 * Resolves a source and validates it has the required method.
 * Throws a helpful error if the source doesn't support the operation,
 * including which sources do support it.
 */
function resolveSourceForMethod<S extends Record<string, SourceAdapter>>(
  sources: S,
  name: string,
  method: "list" | "read" | "search",
): SourceAdapter {
  const adapter = sources[name as keyof S];
  if (!adapter) {
    const available = Object.keys(sources).join(", ");
    throw new Error(`Unknown source: "${name}". Available sources: ${available}`);
  }

  if (adapter[method] == null) {
    const supporting = Object.entries(sources)
      .filter(([, s]) => s[method] != null)
      .map(([n]) => n);
    const suggestion =
      supporting.length > 0
        ? ` Sources that support ${method}: ${supporting.join(", ")}.`
        : ` No sources support ${method}.`;
    throw new Error(`Source "${name}" does not support ${method}().${suggestion}`);
  }

  return adapter;
}
