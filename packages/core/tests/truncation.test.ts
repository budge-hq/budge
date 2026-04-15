import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TraceBuilder } from "../src/trace.ts";
import { buildTools } from "../src/tools.ts";
import { DEFAULT_LIMITS, Truncator } from "../src/truncation.ts";

const writeFileControl = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

  return {
    ...actual,
    writeFile: vi.fn(async (...args: any[]) => {
      if (writeFileControl.error) {
        const error = writeFileControl.error;
        writeFileControl.error = null;
        throw error;
      }

      return (actual.writeFile as (...params: any[]) => Promise<void>)(...args);
    }),
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  writeFileControl.error = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Truncator", () => {
  it("truncates head-first by line count", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });

    const result = await truncator.apply(
      "a\nb\nc\nd",
      { maxLines: 2, direction: "head" },
      context(),
    );

    expect(result.truncated).toBe(true);
    expect(result.removed).toEqual([{ unit: "lines", count: 2 }]);
    expect(preview(result.content)).toBe("a\nb");
  });

  it("clamps overlong lines before applying other limits", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = `${"x".repeat(200 * 1024)}\nsecond line`;

    const result = await truncator.apply(
      text,
      { maxCharsPerLine: 2_000, maxBytes: DEFAULT_LIMITS.READ_MAX_BYTES },
      context(),
    );

    expect(result.truncated).toBe(true);
    expect(preview(result.content)).toContain("... [line truncated]");
    expect(result.content).toContain("[Some lines exceeded 2000 characters and were truncated.]");
    expect(result.removed).toContainEqual({ unit: "chars", count: 200 * 1024 - 2_000 });
  });

  it("truncates tail-first by byte count", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = `${"prefix-"}${"x".repeat(128)}conclusion`;

    const result = await truncator.apply(text, { maxBytes: 32, direction: "tail" }, context());

    expect(result.truncated).toBe(true);
    expect(result.removed).toContainEqual({
      unit: "bytes",
      count: text.length - preview(result.content).length,
    });
    expect(preview(result.content)).toContain("conclusion");
    expect(preview(result.content)).not.toContain("prefix-");
  });

  it("truncates from the middle while keeping both ends", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = "start\nkeep\ntrim\nthis\nout\nfinish";

    const result = await truncator.apply(text, { maxLines: 4, direction: "middle" }, context());

    expect(result.truncated).toBe(true);
    expect(preview(result.content)).toBe("start\nkeep\n[... truncated middle ...]\nout\nfinish");
  });

  it("marks the cut point for middle byte truncation", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = `start-${"x".repeat(64)}-finish`;

    const result = await truncator.apply(text, { maxBytes: 24, direction: "middle" }, context());

    expect(result.truncated).toBe(true);
    expect(preview(result.content)).toContain("[...]");
    expect(byteLength(preview(result.content))).toBeLessThanOrEqual(24);
  });

  it("varies the hint based on subcall availability", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = "a\nb\nc";

    const withSubcalls = await truncator.apply(text, { maxLines: 1 }, context(true, "read_source"));
    const withoutSubcalls = await truncator.apply(
      text,
      { maxLines: 1 },
      context(false, "read_source"),
    );

    expect(withSubcalls.content).toContain("run_subcall on the original source path");
    expect(withSubcalls.content).not.toContain("with this path");
    expect(withoutSubcalls.content).not.toContain("run_subcall");
    expect(withoutSubcalls.content).toContain("smaller offset");
  });

  it("records chars, lines, and bytes when limits compose", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = [
      ...Array.from({ length: 10 }, (_, index) => `line-${index}`),
      "y".repeat(200 * 1024),
      ...Array.from({ length: 4_990 }, (_, index) => `tail-${index}`),
    ].join("\n");

    const result = await truncator.apply(
      text,
      { maxCharsPerLine: 50, maxLines: 2_000, maxBytes: 512, direction: "head" },
      context(),
    );

    expect(result.truncated).toBe(true);
    expect(result.removed?.map((entry) => entry.unit)).toEqual(["chars", "lines", "bytes"]);
    expect(preview(result.content).split("\n").length).toBeLessThanOrEqual(2_000);
    expect(byteLength(preview(result.content))).toBeLessThanOrEqual(512);
    expect(preview(result.content)).toContain("... [line truncated]");
  });

  it("writes the full output to an overflow file", async () => {
    const overflowDir = makeTempDir();
    const truncator = new Truncator({ overflowDir });
    const text = "a\nb\nc\nd";

    const result = await truncator.apply(text, { maxLines: 2 }, context());

    expect(result.overflowPath).toBeDefined();
    expect(result.content).toContain(result.overflowPath!);
    expect(result.overflowPath).toContain(path.join(overflowDir, "read_source-"));
    expect(fs.readFileSync(result.overflowPath!, "utf8")).toBe(text);
  });

  it("still returns truncated output when overflow writes fail", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    writeFileControl.error = new Error("EROFS: read-only file system");

    const result = await truncator.apply("a\nb\nc", { maxLines: 1 }, context());

    expect(result.truncated).toBe(true);
    expect(result.overflowPath).toBeUndefined();
    expect(result.content).toContain("[Output truncated. 2 lines omitted.]");
  });

  it("cleans up overflow files older than the retention window", async () => {
    const overflowDir = makeTempDir();
    const truncator = new Truncator({ overflowDir, retentionMs: 1_000 });
    const oldFile = path.join(overflowDir, "old.txt");
    const freshFile = path.join(overflowDir, "fresh.txt");

    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(freshFile, "fresh");
    const staleSeconds = (Date.now() - 5_000) / 1_000;
    fs.utimesSync(oldFile, staleSeconds, staleSeconds);

    await truncator.cleanup();

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it("does not remove fresh overflow files", async () => {
    const overflowDir = makeTempDir();
    const truncator = new Truncator({ overflowDir, retentionMs: 60_000 });
    const freshFile = path.join(overflowDir, "fresh.txt");

    fs.writeFileSync(freshFile, "fresh");

    await truncator.cleanup();

    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it("wires maxCharsPerLine through read_source", async () => {
    const tools = buildTools({
      sources: {
        codebase: {
          describe: () => "fixture source",
          list: vi.fn(async () => []),
          read: vi.fn(async () => "z".repeat(200 * 1024)),
        },
      },
      worker: {} as never,
      trace: new TraceBuilder("inspect minified file"),
      truncator: new Truncator({ overflowDir: makeTempDir() }),
    });

    const result = await (tools as any).read_source.execute!(
      { source: "codebase", path: "dist/minified.js" },
      {} as never,
    );

    expect(result).toContain("... [line truncated]");
    expect(result).toContain(
      `[Some lines exceeded ${DEFAULT_LIMITS.READ_MAX_CHARS_PER_LINE} characters and were truncated.]`,
    );
  });

  it("returns inline errors for read_source without truncation metadata", async () => {
    const trace = new TraceBuilder("inspect read error");
    const tools = buildTools({
      sources: {
        codebase: {
          describe: () => "fixture source",
          list: vi.fn(async () => []),
          read: vi.fn(async () => {
            throw new Error("boom");
          }),
        },
      },
      worker: {} as never,
      trace,
      truncator: new Truncator({ overflowDir: makeTempDir() }),
    });

    const result = await (tools as any).read_source.execute!(
      { source: "codebase", path: "missing.ts" },
      {} as never,
    );
    const built = trace.build();

    expect(result).toBe("[Error reading codebase/missing.ts: boom]");
    expect(built.tree.toolCalls[0]).toMatchObject({
      tool: "read_source",
      result,
      truncated: false,
    });
    expect(built.tree.toolCalls[0]?.overflowPath).toBeUndefined();
  });

  it("returns inline errors for list_source without truncation metadata", async () => {
    const trace = new TraceBuilder("inspect list error");
    const tools = buildTools({
      sources: {
        codebase: {
          describe: () => "fixture source",
          list: vi.fn(async () => {
            throw new Error("boom");
          }),
          read: vi.fn(async () => "contents"),
        },
      },
      worker: {} as never,
      trace,
      truncator: new Truncator({ overflowDir: makeTempDir() }),
    });

    const result = await (tools as any).list_source.execute!(
      { source: "codebase", path: "src" },
      {} as never,
    );
    const built = trace.build();

    expect(result).toBe("[Error listing codebase/src: boom]");
    expect(built.tree.toolCalls[0]).toMatchObject({
      tool: "list_source",
      result,
      truncated: false,
    });
    expect(built.tree.toolCalls[0]?.overflowPath).toBeUndefined();
  });
});

function preview(content: string): string {
  const lineNoticeIndex = content.indexOf("\n\n[Some lines exceeded");
  const outputNoticeIndex = content.indexOf("\n\n[Output truncated.");
  const indexes = [lineNoticeIndex, outputNoticeIndex].filter((index) => index >= 0);
  const cutoff = indexes.length === 0 ? content.length : Math.min(...indexes);
  return content.slice(0, cutoff);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function context(hasSubcalls = true, toolName = "read_source") {
  return { toolName, hasSubcalls } as const;
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budge-truncation-test-"));
  tempDirs.push(dir);
  return dir;
}
