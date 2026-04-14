import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Truncator } from "../src/truncation.ts";

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
    expect(result.removed).toEqual({ unit: "lines", count: 2 });
    expect(preview(result.content)).toBe("a\nb");
  });

  it("truncates tail-first by byte count", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = `${"prefix-"}${"x".repeat(128)}conclusion`;

    const result = await truncator.apply(text, { maxBytes: 32, direction: "tail" }, context());

    expect(result.truncated).toBe(true);
    expect(result.removed?.unit).toBe("bytes");
    expect(preview(result.content)).toContain("conclusion");
    expect(preview(result.content)).not.toContain("prefix-");
  });

  it("truncates from the middle while keeping both ends", async () => {
    const truncator = new Truncator({ overflowDir: makeTempDir() });
    const text = "start\nkeep\ntrim\nthis\nout\nfinish";

    const result = await truncator.apply(text, { maxLines: 4, direction: "middle" }, context());

    expect(result.truncated).toBe(true);
    expect(preview(result.content)).toBe("start\nkeep\nout\nfinish");
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

    expect(withSubcalls.content).toContain("run_subcall");
    expect(withoutSubcalls.content).not.toContain("run_subcall");
    expect(withoutSubcalls.content).toContain("smaller offset");
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
});

function preview(content: string): string {
  return content.split("\n\n[Output truncated.")[0] ?? content;
}

function context(hasSubcalls = true, toolName = "read_source") {
  return { toolName, hasSubcalls } as const;
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budge-truncation-test-"));
  tempDirs.push(dir);
  return dir;
}
