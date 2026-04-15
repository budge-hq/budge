import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LanguageModel } from "ai";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { runAgent } from "../src/agent.ts";
import * as agentModule from "../src/agent.ts";
import { createBudge } from "../src/budge.ts";
import * as handoffModule from "../src/handoff.ts";
import { runSubcall } from "../src/subcall.ts";
import { TraceBuilder } from "../src/trace.ts";
import { buildTools } from "../src/tools.ts";
import * as toolsModule from "../src/tools.ts";
import { DEFAULT_LIMITS, Truncator } from "../src/truncation.ts";

const { mockGenerate, agentInstances } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  agentInstances: [] as Array<{ settings: Record<string, unknown> }>,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    ToolLoopAgent: class MockToolLoopAgent {
      constructor(public settings: Record<string, unknown>) {
        agentInstances.push(this);
      }
      generate = mockGenerate;
    },
  };
});

const worker = { specificationVersion: "v3" as const } as LanguageModel;
const orchestrator = { specificationVersion: "v3" as const } as LanguageModel;
const tempDirs: string[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeAdapter() {
  return {
    describe: () => "fixture source",
    list: vi.fn(async () => []),
    read: vi.fn(async (path: string) => `contents for ${path}`),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  agentInstances.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runSubcall()", () => {
  it("throws a helpful error when adapter does not support read()", async () => {
    const searchOnlyAdapter = {
      describe: () => "search-only source",
      search: async () => [],
    };

    await expect(
      runSubcall({
        worker,
        adapter: searchOnlyAdapter,
        sourceName: "precedent",
        path: "chunk:0",
        task: "summarize",
      }),
    ).rejects.toThrow(/does not support read/i);
  });

  it("keeps the untyped path unchanged", async () => {
    mockGenerate.mockResolvedValue({
      text: "summary",
      usage: { inputTokens: 3, outputTokens: 4 },
    });

    const node = await runSubcall({
      worker,
      adapter: makeAdapter(),
      sourceName: "codebase",
      path: "src/auth.ts",
      task: "summarize this file",
    });

    expect(node.answer).toBe("summary");
    expect(node.structured).toBeUndefined();
    expect(node.schemaName).toBeUndefined();
    // Verify the agent was NOT constructed with an output option
    const lastAgent = agentInstances[agentInstances.length - 1]!;
    expect(lastAgent.settings).not.toHaveProperty("output");
  });

  it("stores structured output when a schema is provided", async () => {
    const structured = [
      {
        line: 12,
        context: "fetch('/api')",
        verdict: "missing",
      },
    ] as const;

    mockGenerate.mockResolvedValue({
      output: structured,
      usage: { inputTokens: 5, outputTokens: 6 },
    });

    const node = await runSubcall({
      worker,
      adapter: makeAdapter(),
      sourceName: "codebase",
      path: "src/auth.ts",
      task: "audit fetch handling",
      schemaName: "fetch-audit",
      schema: z.array(
        z.object({
          line: z.number(),
          context: z.string(),
          verdict: z.enum(["missing", "present"]),
        }),
      ),
    });

    expect(JSON.parse(node.answer)).toEqual(structured);
    expect(node.structured).toEqual(structured);
    expect(node.schemaName).toBe("fetch-audit");
    // Verify the agent was constructed with an output option
    const lastAgent = agentInstances[agentInstances.length - 1]!;
    expect(lastAgent.settings).toHaveProperty("output");
  });

  it("rethrows structured output validation failures", async () => {
    const error = new Error("No object generated: response did not match schema.");
    mockGenerate.mockRejectedValue(error);

    await expect(
      runSubcall({
        worker,
        adapter: makeAdapter(),
        sourceName: "codebase",
        path: "src/auth.ts",
        task: "audit fetch handling",
        schemaName: "fetch-audit",
        schema: z.array(
          z.object({
            line: z.number(),
            context: z.string(),
            verdict: z.enum(["missing", "present"]),
          }),
        ),
      }),
    ).rejects.toBe(error);
  });
});

describe("buildTools().run_subcall", () => {
  it("returns a string while recording structured trace data", async () => {
    const structured = {
      verdict: "missing",
      context: "fetch('/api')",
    } as const;
    const events: Array<unknown> = [];
    const trace = new TraceBuilder("audit fetch handling");

    mockGenerate.mockResolvedValue({
      output: structured,
      usage: { inputTokens: 2, outputTokens: 3 },
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace,
      onToolCall: (event) => events.push(event),
      subcallSchemas: {
        audit: z.object({
          verdict: z.enum(["missing", "present"]),
          context: z.string(),
        }),
      },
    });

    const result = await tools.run_subcall.execute!(
      {
        source: "codebase",
        path: "src/auth.ts",
        task: "audit fetch handling",
        schemaName: "audit",
      },
      {} as never,
    );

    const built = trace.build();

    expect(typeof result).toBe("string");
    if (typeof result !== "string") {
      throw new Error("Expected run_subcall to return a string");
    }

    expect(JSON.parse(result)).toEqual(structured);
    expect(events).toEqual([
      {
        tool: "run_subcall",
        args: {
          source: "codebase",
          path: "src/auth.ts",
          task: "audit fetch handling",
          schemaName: "audit",
        },
      },
    ]);
    expect(built.tree.children).toHaveLength(1);
    expect(built.tree.children[0]).toMatchObject({
      source: "codebase",
      path: "src/auth.ts",
      task: "audit fetch handling",
      schemaName: "audit",
      structured,
    });
    expect(built.tree.toolCalls[0]).toMatchObject({
      tool: "run_subcall",
      result,
    });
  });

  it("tail-truncates oversized subcall answers and records overflow metadata", async () => {
    const trace = new TraceBuilder("audit fetch handling");
    const overflowDir = makeTempDir();
    const longAnswer = `${"prefix-"}${"x".repeat(DEFAULT_LIMITS.SUBCALL_MAX_BYTES + 1_024)}conclusion`;

    mockGenerate.mockResolvedValue({
      text: longAnswer,
      usage: { inputTokens: 2, outputTokens: 3 },
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace,
      truncator: new Truncator({ overflowDir }),
    });

    const result = await tools.run_subcall.execute!(
      {
        source: "codebase",
        path: "src/auth.ts",
        task: "audit fetch handling",
      },
      {} as never,
    );

    const built = trace.build();

    expect(typeof result).toBe("string");
    if (typeof result !== "string") {
      throw new Error("Expected run_subcall to return a string");
    }

    expect(result).toContain("conclusion");
    expect(result).not.toContain("prefix-");
    expect(result).toContain("[Output truncated.");
    expect(built.tree.children[0]).toMatchObject({
      path: "src/auth.ts",
      truncated: true,
    });
    expect(built.tree.children[0]?.overflowPath).toBeDefined();
    expect(fs.existsSync(built.tree.children[0]?.overflowPath ?? "")).toBe(true);
    expect(built.tree.toolCalls[0]).toMatchObject({
      tool: "run_subcall",
      truncated: true,
      overflowPath: built.tree.children[0]?.overflowPath,
    });
  });

  it("surfaces oversized structured subcall output as a diagnostic while preserving structured data", async () => {
    const trace = new TraceBuilder("audit fetch handling");
    const structured = {
      verdict: "missing",
      context: "x".repeat(DEFAULT_LIMITS.SUBCALL_MAX_BYTES + 2_048),
    };

    mockGenerate.mockResolvedValue({
      output: structured,
      usage: { inputTokens: 2, outputTokens: 3 },
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace,
      subcallSchemas: {
        audit: z.object({
          verdict: z.enum(["missing", "present"]),
          context: z.string(),
        }),
      },
    });

    const result = await tools.run_subcall.execute!(
      {
        source: "codebase",
        path: "src/auth.ts",
        task: "audit fetch handling",
        schemaName: "audit",
      },
      {} as never,
    );
    const built = trace.build();
    const structuredNode = built.tree.children[0];

    expect(result).toContain('Structured subcall "audit" output exceeded');
    expect(result).toContain(`${JSON.stringify(structured).length} bytes`);
    expect(structuredNode).toMatchObject({
      schemaName: "audit",
      structured,
      truncated: true,
    });
    expect(structuredNode?.overflowPath).toBeUndefined();
    expect(built.tree.toolCalls[0]).toMatchObject({
      tool: "run_subcall",
      result,
      truncated: true,
    });
    expect(built.tree.toolCalls[0]?.overflowPath).toBeUndefined();
  });

  it("returns an error string for unknown schema names (consistent with run_subcalls)", async () => {
    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace: new TraceBuilder("audit fetch handling"),
      subcallSchemas: {
        audit: z.string(),
        summary: z.object({ title: z.string() }),
      },
    });

    const result = await tools.run_subcall.execute!(
      {
        source: "codebase",
        path: "src/auth.ts",
        task: "audit fetch handling",
        schemaName: "missing",
      },
      {} as never,
    );

    expect(result).toMatch(/Unknown subcall schema.*missing/i);
    // execute() resolved — the error is surfaced as a string result the
    // orchestrator can see and recover from, not an unhandled rejection.
  });

  it("returns an error string for unknown source names in run_subcall", async () => {
    mockGenerate.mockResolvedValue({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace: new TraceBuilder("bad source"),
    });

    const result = await tools.run_subcall.execute!(
      { source: "nonexistent", path: "src/auth.ts", task: "summarize" },
      {} as never,
    );

    expect(result).toMatch(/unknown source.*nonexistent/i);
  });

  it("runs run_subcalls in parallel while preserving input order", async () => {
    const readGates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let readIndex = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    let activeReadsAtBatchStart = -1;
    const trace = new TraceBuilder("batch analysis");
    const adapter = {
      describe: () => "fixture source",
      list: vi.fn(async () => []),
      read: vi.fn(async (path: string) => {
        const currentIndex = readIndex++;
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await readGates[currentIndex]!.promise;
        activeReads--;
        return `contents for ${path}`;
      }),
    };

    mockGenerate.mockImplementation(async (args: { prompt?: unknown }) => {
      const messages = args.prompt;
      const firstMessage = Array.isArray(messages) ? messages[0] : undefined;
      const text = typeof firstMessage?.content === "string" ? firstMessage.content : "";
      const filePath = /path: ([^)]+)\)/.exec(text)?.[1] ?? "unknown";
      return {
        text: `analysis for ${filePath}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const tools = buildTools({
      sources: { codebase: adapter },
      worker,
      trace,
      concurrency: 2,
      onToolCall: (event) => {
        if (event.tool === "run_subcalls") {
          activeReadsAtBatchStart = activeReads;
        }
      },
    });

    const resultPromise = tools.run_subcalls.execute!(
      {
        calls: [
          { source: "codebase", path: "src/a.ts", task: "summarize a" },
          { source: "codebase", path: "src/b.ts", task: "summarize b" },
          { source: "codebase", path: "src/c.ts", task: "summarize c" },
        ],
      },
      {} as never,
    );

    await flushAsyncWork();

    expect(activeReadsAtBatchStart).toBe(0);
    expect(activeReads).toBe(2);

    readGates[1]!.resolve();
    await flushAsyncWork();
    expect(activeReads).toBe(2);

    readGates[2]!.resolve();
    await flushAsyncWork();

    readGates[0]!.resolve();

    const result = await resultPromise;
    const built = trace.build();

    expect(result).toEqual([
      {
        source: "codebase",
        path: "src/a.ts",
        task: "summarize a",
        answer: "analysis for src/a.ts",
      },
      {
        source: "codebase",
        path: "src/b.ts",
        task: "summarize b",
        answer: "analysis for src/b.ts",
      },
      {
        source: "codebase",
        path: "src/c.ts",
        task: "summarize c",
        answer: "analysis for src/c.ts",
      },
    ]);
    expect(maxActiveReads).toBe(2);
    expect(built.tree.children).toHaveLength(3);
    expect(built.tree.children.map((child) => child.parallel)).toEqual([true, true, true]);
    expect(built.tree.toolCalls[0]).toMatchObject({
      tool: "run_subcalls",
    });
  });

  it("degrades an invalid schema name into a per-result error node", async () => {
    const adapter = makeAdapter();
    const events: Array<unknown> = [];
    const tools = buildTools({
      sources: { codebase: adapter },
      worker,
      trace: new TraceBuilder("audit fetch handling"),
      onToolCall: (event) => events.push(event),
      subcallSchemas: {
        audit: z.string(),
      },
    });

    const result = await tools.run_subcalls.execute!(
      {
        calls: [
          {
            source: "codebase",
            path: "src/auth.ts",
            task: "audit fetch handling",
            schemaName: "missing",
          },
        ],
      },
      {} as never,
    );

    // execute() resolves — the error is contained in the result node
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ answer: string }>)[0]!.answer).toMatch(
      /Unknown subcall schema.*missing/i,
    );
    // onToolCall still fires (the batch started)
    expect(events).toHaveLength(1);
    expect((events[0] as { tool: string }).tool).toBe("run_subcalls");
  });

  it("isolates per-call errors: valid calls still complete when one call references an unknown source", async () => {
    mockGenerate.mockResolvedValue({
      text: "summary",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace: new TraceBuilder("batch with bad source"),
      concurrency: 2,
    });

    const result = (await tools.run_subcalls.execute!(
      {
        calls: [
          { source: "codebase", path: "src/a.ts", task: "summarize a" },
          { source: "nonexistent", path: "src/b.ts", task: "summarize b" },
          { source: "codebase", path: "src/c.ts", task: "summarize c" },
        ],
      },
      {} as never,
    )) as Array<{ source: string; answer: string }>;

    expect(result).toHaveLength(3);
    // Good calls complete normally
    expect(result[0]!.answer).toBe("summary");
    expect(result[2]!.answer).toBe("summary");
    // Bad call degrades to an error node, doesn't throw the whole batch
    expect(result[1]!.answer).toMatch(/unknown source.*nonexistent/i);
  });

  it("degrades execution failures into per-result answers", async () => {
    const trace = new TraceBuilder("batch analysis");

    mockGenerate.mockImplementation(async (args: { prompt?: unknown }) => {
      const messages = args.prompt;
      const firstMessage = Array.isArray(messages) ? messages[0] : undefined;
      const text = typeof firstMessage?.content === "string" ? firstMessage.content : "";
      const filePath = /path: ([^)]+)\)/.exec(text)?.[1] ?? "unknown";
      if (filePath === "src/b.ts") {
        throw new Error("model exploded");
      }
      return {
        text: `analysis for ${filePath}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace,
      concurrency: 2,
    });

    const result = await tools.run_subcalls.execute!(
      {
        calls: [
          { source: "codebase", path: "src/a.ts", task: "summarize a" },
          { source: "codebase", path: "src/b.ts", task: "summarize b" },
        ],
      },
      {} as never,
    );

    const built = trace.build();

    expect(result).toEqual([
      {
        source: "codebase",
        path: "src/a.ts",
        task: "summarize a",
        answer: "analysis for src/a.ts",
      },
      {
        source: "codebase",
        path: "src/b.ts",
        task: "summarize b",
        answer: "[Error: model exploded]",
      },
    ]);
    expect(built.tree.children).toHaveLength(2);
    expect(built.tree.children[1]).toMatchObject({
      path: "src/b.ts",
      answer: "[Error: model exploded]",
      parallel: true,
    });
  });

  it("truncates oversized batch answers per subcall while keeping the outer batch intact", async () => {
    const trace = new TraceBuilder("batch analysis");
    const overflowDir = makeTempDir();
    const longAnswer = `${"prefix-"}${"x".repeat(DEFAULT_LIMITS.SUBCALL_MAX_BYTES + 2_048)}conclusion-b`;

    mockGenerate.mockImplementation(async (args: { prompt?: unknown }) => {
      const messages = args.prompt;
      const firstMessage = Array.isArray(messages) ? messages[0] : undefined;
      const text = typeof firstMessage?.content === "string" ? firstMessage.content : "";
      const filePath = /path: ([^)]+)\)/.exec(text)?.[1] ?? "unknown";
      return {
        text: filePath === "src/b.ts" ? longAnswer : `analysis for ${filePath}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace,
      concurrency: 2,
      truncator: new Truncator({ overflowDir }),
    });

    const result = await tools.run_subcalls.execute!(
      {
        calls: [
          { source: "codebase", path: "src/a.ts", task: "summarize a" },
          { source: "codebase", path: "src/b.ts", task: "summarize b" },
        ],
      },
      {} as never,
    );

    const built = trace.build();
    const truncatedChild = built.tree.children.find((child) => child.path === "src/b.ts");
    const outerToolCall = built.tree.toolCalls[0];

    if (!Array.isArray(result)) {
      throw new Error("Expected run_subcalls to return an array");
    }

    expect(result[0]?.answer).toBe("analysis for src/a.ts");
    expect(result[1]?.answer).toContain("conclusion-b");
    expect(result[1]?.answer).not.toContain("prefix-");
    expect(result[1]?.answer).toContain("[Output truncated.");
    expect(truncatedChild).toMatchObject({
      path: "src/b.ts",
      truncated: true,
    });
    expect(truncatedChild?.overflowPath).toContain("run_subcalls[1]-");
    expect(result[1]?.answer).toContain(truncatedChild?.overflowPath ?? "");
    expect(outerToolCall).toMatchObject({
      tool: "run_subcalls",
      truncated: false,
    });
    expect(outerToolCall?.overflowPath).toBeUndefined();
  });

  it("surfaces oversized structured batch output on the child node without truncating the outer batch", async () => {
    const trace = new TraceBuilder("batch analysis");
    const structured = {
      verdict: "missing",
      context: "x".repeat(DEFAULT_LIMITS.SUBCALL_MAX_BYTES + 2_048),
    };

    mockGenerate.mockImplementation(async (args: { prompt?: unknown }) => {
      const messages = args.prompt;
      const firstMessage = Array.isArray(messages) ? messages[0] : undefined;
      const text = typeof firstMessage?.content === "string" ? firstMessage.content : "";
      const filePath = /path: ([^)]+)\)/.exec(text)?.[1] ?? "unknown";

      return {
        output:
          filePath === "src/b.ts"
            ? structured
            : {
                verdict: "present",
                context: `analysis for ${filePath}`,
              },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const tools = buildTools({
      sources: { codebase: makeAdapter() },
      worker,
      trace,
      concurrency: 2,
      subcallSchemas: {
        audit: z.object({
          verdict: z.enum(["missing", "present"]),
          context: z.string(),
        }),
      },
    });

    const result = await tools.run_subcalls.execute!(
      {
        calls: [
          { source: "codebase", path: "src/a.ts", task: "summarize a", schemaName: "audit" },
          { source: "codebase", path: "src/b.ts", task: "summarize b", schemaName: "audit" },
        ],
      },
      {} as never,
    );
    const built = trace.build();
    const oversizedChild = built.tree.children.find((child) => child.path === "src/b.ts");
    const outerToolCall = built.tree.toolCalls[0];

    if (!Array.isArray(result)) {
      throw new Error("Expected run_subcalls to return an array");
    }

    expect(JSON.parse(result[0]?.answer ?? "null")).toEqual({
      verdict: "present",
      context: "analysis for src/a.ts",
    });
    expect(result[1]?.answer).toContain('Structured subcall "audit" output exceeded');
    expect(oversizedChild).toMatchObject({
      path: "src/b.ts",
      schemaName: "audit",
      structured,
      truncated: true,
    });
    expect(oversizedChild?.overflowPath).toBeUndefined();
    expect(outerToolCall).toMatchObject({
      tool: "run_subcalls",
      truncated: false,
    });
    expect(outerToolCall?.overflowPath).toBeUndefined();
  });
});

describe("schema propagation", () => {
  it("forwards subcallSchemas from runAgent into buildTools", async () => {
    const buildToolsSpy = vi.spyOn(toolsModule, "buildTools").mockReturnValue({} as never);
    const trace = new TraceBuilder("audit fetch handling");
    const subcallSchemas = {
      audit: z.object({ verdict: z.enum(["missing", "present"]) }),
    };

    mockGenerate.mockResolvedValue({
      steps: [],
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    await runAgent({
      orchestrator,
      worker,
      concurrency: 7,
      task: "audit fetch handling",
      sources: { codebase: makeAdapter() },
      subcallSchemas,
      trace,
      truncator: new Truncator({ enabled: false }),
    });

    expect(buildToolsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        subcallSchemas,
        concurrency: 7,
      }),
    );
  });

  it("forwards worker and concurrency from budge.prepare into runAgent", async () => {
    const runAgentSpy = vi.spyOn(agentModule, "runAgent").mockResolvedValue({
      answer: "done",
      finishReason: "finish",
    });
    vi.spyOn(handoffModule, "buildHandoff").mockResolvedValue({
      structured: {
        goal: "audit fetch handling",
        instructions: [],
        discoveries: ["done"],
        relevantSources: [],
        openQuestions: [],
        confidence: "Medium",
        confidenceRationale: "test fixture",
      },
      markdown: "briefing",
    });

    const budge = createBudge({ orchestrator, worker, concurrency: 7 });
    const subcallSchemas = {
      audit: z.object({ verdict: z.enum(["missing", "present"]) }),
    };

    await budge.prepare({
      task: "audit fetch handling",
      sources: { codebase: makeAdapter() },
      subcallSchemas,
    });

    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        // Models are wrapped with withPromptCaching — they are no longer the raw
        // model instances, but the wrapped versions should still be LanguageModels.
        orchestrator: expect.objectContaining({ specificationVersion: "v3" }),
        worker: expect.objectContaining({ specificationVersion: "v3" }),
        concurrency: 7,
        subcallSchemas,
      }),
    );
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budge-subcall-test-"));
  tempDirs.push(dir);
  return dir;
}
