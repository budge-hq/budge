import { tool } from "ai";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ContributedToolEvents, ToolCallEvent } from "../src/types.ts";
import type { SourceAdapter } from "../src/sources/interface.ts";
import { buildTools } from "../src/tools.ts";
import { TraceBuilder } from "../src/trace.ts";
import { Truncator } from "../src/truncation.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorker() {
  return {} as LanguageModel;
}

function makeTrace() {
  return new TraceBuilder("test");
}

function makeTruncator() {
  return new Truncator({ enabled: false });
}

/** Source with list + read (filesystem-style) */
function makeListReadSource() {
  return {
    describe: () => "list+read source",
    list: async () => ["a.txt", "b.txt"],
    read: async (p: string) => `content of ${p}`,
  };
}

/** Source with search only */
function makeSearchSource() {
  return {
    describe: () => "search-only source",
    search: async () => [],
  };
}

/** Source with tools only */
function makeToolsSource() {
  return {
    describe: () => "tools-only source",
    tools: () => ({
      get_patient: tool({
        description: "Get a patient by ID",
        inputSchema: z.object({ id: z.number() }),
        execute: async ({ id }: { id: number }) => ({ id, name: "Alice" }),
      }),
      search_patients: tool({
        description: "Search patients",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }: { name: string }) => [{ id: 1, name }],
      }),
    }),
  };
}

/** Source with all methods */
function makeFullSource() {
  return {
    describe: () => "full source",
    list: async () => ["chunk:0"],
    read: async () => "content",
    search: async () => [],
    tools: () => ({
      custom_tool: tool({
        description: "custom",
        inputSchema: z.object({ x: z.string() }),
        execute: async ({ x }: { x: string }) => x,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Conditional tool registration
// ---------------------------------------------------------------------------

describe("buildTools() — conditional standard tool registration", () => {
  it("registers list_source when at least one source has list", () => {
    const tools = buildTools({
      sources: { docs: makeListReadSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.list_source).toBeDefined();
  });

  it("does NOT register list_source when no source has list", () => {
    const tools = buildTools({
      sources: { notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.list_source).toBeUndefined();
  });

  it("registers read_source when at least one source has read", () => {
    const tools = buildTools({
      sources: { docs: makeListReadSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.read_source).toBeDefined();
  });

  it("does NOT register read_source when no source has read", () => {
    const tools = buildTools({
      sources: { notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.read_source).toBeUndefined();
  });

  it("registers search_source when at least one source has search", () => {
    const tools = buildTools({
      sources: { notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.search_source).toBeDefined();
  });

  it("does NOT register search_source when no source has search", () => {
    const tools = buildTools({
      sources: { docs: makeListReadSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.search_source).toBeUndefined();
  });

  it("registers all three when one source has all methods", () => {
    const tools = buildTools({
      sources: { full: makeFullSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.list_source).toBeDefined();
    expect(tools.read_source).toBeDefined();
    expect(tools.search_source).toBeDefined();
  });

  it("always registers run_subcall, run_subcalls, and finish", () => {
    // Even with a search-only source
    const tools = buildTools({
      sources: { notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools.run_subcall).toBeDefined();
    expect(tools.run_subcalls).toBeDefined();
    expect(tools.finish).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Source-contributed tools — namespacing
// ---------------------------------------------------------------------------

describe("buildTools() — source-contributed tools", () => {
  it("namespaces contributed tools with source name", () => {
    const tools = buildTools({
      sources: { db: makeToolsSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools["db.get_patient"]).toBeDefined();
    expect(tools["db.search_patients"]).toBeDefined();
  });

  it("does not expose un-namespaced contributed tool names", () => {
    const tools = buildTools({
      sources: { db: makeToolsSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools["get_patient"]).toBeUndefined();
    expect(tools["search_patients"]).toBeUndefined();
  });

  it("multiple sources each get their own namespace", () => {
    const tools = buildTools({
      sources: {
        db: makeToolsSource(),
        full: makeFullSource(),
      },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, unknown>;

    expect(tools["db.get_patient"]).toBeDefined();
    expect(tools["db.search_patients"]).toBeDefined();
    expect(tools["full.custom_tool"]).toBeDefined();
  });

  it("fires onToolCall for contributed tool invocations", async () => {
    const events: Array<{ tool: string; args: unknown }> = [];
    const trace = new TraceBuilder("observability test");
    const tools = buildTools({
      sources: { db: makeToolsSource() },
      worker: makeWorker(),
      trace,
      truncator: makeTruncator(),
      onToolCall: (event) => events.push(event),
    }) as Record<string, any>;

    await tools["db.get_patient"].execute({ id: 42 }, {} as never);

    expect(events).toHaveLength(1);
    expect(events[0]!.tool).toBe("db.get_patient");
    expect(events[0]!.args).toEqual({ id: 42 });
  });

  it("records contributed tool calls in the trace", async () => {
    const trace = new TraceBuilder("trace test");
    const tools = buildTools({
      sources: { db: makeToolsSource() },
      worker: makeWorker(),
      trace,
      truncator: makeTruncator(),
    }) as Record<string, any>;

    await tools["db.get_patient"].execute({ id: 99 }, {} as never);

    const built = trace.build();
    const record = built.tree.toolCalls.find((c) => c.tool === "db.get_patient");
    expect(record).toBeDefined();
    expect(record!.args).toEqual({ id: 99 });
    expect(typeof record!.durationMs).toBe("number");
  });

  it("returns the original tool result unchanged", async () => {
    const tools = buildTools({
      sources: { db: makeToolsSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, any>;

    const result = await tools["db.get_patient"].execute({ id: 1 }, {} as never);
    expect(result).toEqual({ id: 1, name: "Alice" });
  });
});

// ---------------------------------------------------------------------------
// ToolCallEvent<S> — type-level narrowing tests
// These are compile-time assertions: if they compile, the types are correct.
// ---------------------------------------------------------------------------

describe("ToolCallEvent<S> — type inference", () => {
  it("ContributedToolEvents derives typed variants from tools() sources", () => {
    // Type-level test: ContributedToolEvents<Sources> should produce a
    // discriminated union with typed args for each contributed tool.
    const db = {
      describe: () => "db",
      tools: () => ({
        get_patient: tool({
          description: "get patient",
          inputSchema: z.object({ id: z.number() }),
          execute: async ({ id }: { id: number }) => ({ id, name: "Alice" }),
        }),
      }),
    } satisfies SourceAdapter;

    type Sources = { db: typeof db };
    type Events = ContributedToolEvents<Sources>;

    // This is a compile-time assertion — if TypeScript accepts the cast,
    // ContributedToolEvents correctly derived the typed variant.
    const event = { tool: "db.get_patient" as const, args: { id: 42 } } satisfies Events;
    expect(event.args.id).toBe(42);
  });

  it("ToolCallEvent<S> includes both built-in and contributed variants", () => {
    const db = {
      describe: () => "db",
      tools: () => ({
        get_patient: tool({
          description: "get patient",
          inputSchema: z.object({ id: z.number() }),
          execute: async ({ id }: { id: number }) => ({ id }),
        }),
      }),
    } satisfies SourceAdapter;

    type Sources = { db: typeof db };

    // Both built-in and contributed events satisfy ToolCallEvent<Sources>
    const builtIn = {
      tool: "read_source" as const,
      args: { source: "db", path: "foo" },
    } satisfies ToolCallEvent<Sources>;

    const contributed = {
      tool: "db.get_patient" as const,
      args: { id: 1 },
    } satisfies ToolCallEvent<Sources>;

    expect(builtIn.tool).toBe("read_source");
    expect(contributed.tool).toBe("db.get_patient");
  });

  it("onToolCall receives typed args for contributed tools at runtime", async () => {
    // Runtime test: the typed args actually arrive at the callback
    const receivedArgs: Array<{ id: number }> = [];

    const db = {
      describe: () => "db",
      tools: () => ({
        get_patient: tool({
          description: "get patient",
          inputSchema: z.object({ id: z.number() }),
          execute: async ({ id }: { id: number }) => ({ id, name: "Alice" }),
        }),
      }),
    } satisfies SourceAdapter;

    type Sources = { db: typeof db };

    const allTools = buildTools({
      sources: { db },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
      onToolCall: (event: ToolCallEvent<Sources>) => {
        if (event.tool === "db.get_patient") {
          // TypeScript narrows event.args.id to number here
          receivedArgs.push({ id: event.args.id });
        }
      },
    }) as Record<string, any>;

    await allTools["db.get_patient"].execute({ id: 7 }, {} as never);

    expect(receivedArgs).toEqual([{ id: 7 }]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic descriptions
// ---------------------------------------------------------------------------

describe("buildTools() — dynamic descriptions", () => {
  it("list_source description mentions supporting sources", () => {
    const tools = buildTools({
      sources: { docs: makeListReadSource(), notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, { description?: string }>;

    const desc = tools.list_source?.description ?? "";
    expect(desc).toContain("docs");
  });

  it("list_source description mentions non-supporting sources", () => {
    const tools = buildTools({
      sources: { docs: makeListReadSource(), notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, { description?: string }>;

    const desc = tools.list_source?.description ?? "";
    expect(desc).toContain("notes");
    expect(desc).toContain("search_source");
  });

  it("search_source description includes per-source describe() text", () => {
    const tools = buildTools({
      sources: { notes: makeSearchSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, { description?: string }>;

    const desc = tools.search_source?.description ?? "";
    expect(desc).toContain("search-only source");
    expect(desc).toContain("MULTIPLE searches");
  });
});

// ---------------------------------------------------------------------------
// resolveSourceForMethod — helpful errors
// ---------------------------------------------------------------------------

describe("buildTools() — resolveSourceForMethod errors", () => {
  it("throws helpful error when source doesn't exist", async () => {
    const tools = buildTools({
      sources: { docs: makeListReadSource() },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, any>;

    await expect(
      tools.read_source.execute({ source: "nonexistent", path: "foo" }, {} as never),
    ).rejects.toThrow(/unknown source.*nonexistent/i);
  });

  it("returns an error string when source doesn't support the called method", async () => {
    const tools = buildTools({
      sources: {
        notes: makeSearchSource(),
        docs: makeListReadSource(),
      },
      worker: makeWorker(),
      trace: makeTrace(),
      truncator: makeTruncator(),
    }) as Record<string, any>;

    // notes has no read() — run_subcall should degrade to an error string
    const result = await tools.run_subcall.execute(
      { source: "notes", path: "chunk:0", task: "summarize" },
      {} as never,
    );
    expect(result).toMatch(/does not support read/i);
  });
});
