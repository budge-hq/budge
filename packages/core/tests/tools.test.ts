import { tool } from "ai";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { LanguageModel } from "ai";
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
