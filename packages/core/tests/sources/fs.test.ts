import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FsAdapter } from "../../src/sources/fs.ts";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budge-fs-test-"));

  // Create fixture structure:
  //   tmpDir/
  //     index.ts
  //     utils.ts
  //     README.md
  //     lib/
  //       helper.ts
  //       math.ts
  //     node_modules/   ← should be excluded by default
  //       lodash/
  //         index.js

  fs.writeFileSync(path.join(tmpDir, "index.ts"), 'export const hello = "world"\n');
  fs.writeFileSync(path.join(tmpDir, "utils.ts"), "export function noop() {}\n");
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test repo\n");
  fs.mkdirSync(path.join(tmpDir, "lib"));
  fs.writeFileSync(path.join(tmpDir, "lib", "helper.ts"), "export const x = 1\n");
  fs.writeFileSync(path.join(tmpDir, "lib", "math.ts"), "export const pi = 3.14\n");
  fs.mkdirSync(path.join(tmpDir, "node_modules", "lodash"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "node_modules", "lodash", "index.js"), "module.exports = {}");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// excludePatterns option
// ---------------------------------------------------------------------------

describe("FsAdapter — excludePatterns option", () => {
  it("merges excludePatterns with defaults (both are excluded)", async () => {
    // Create a custom dir to exclude
    fs.mkdirSync(path.join(tmpDir, "build"));
    fs.writeFileSync(path.join(tmpDir, "build", "output.js"), "module.exports = {}");

    const adapter = new FsAdapter(tmpDir, { excludePatterns: ["build"] });
    const entries = await adapter.list();

    // node_modules still excluded (default), build also excluded (additive)
    expect(entries.every((e) => !e.startsWith("node_modules"))).toBe(true);
    expect(entries.every((e) => !e.startsWith("build"))).toBe(true);
    // Other files are still visible
    expect(entries).toContain("index.ts");
  });

  it("excludePatterns does not replace the defaults", async () => {
    const adapter = new FsAdapter(tmpDir, { excludePatterns: ["build"] });
    const entries = await adapter.list();
    // node_modules is still excluded even though we only added "build"
    expect(entries.every((e) => !e.startsWith("node_modules"))).toBe(true);
  });

  it("exclude (without excludePatterns) replaces defaults entirely", async () => {
    // exclude replaces defaults — node_modules is NOT excluded, lib is excluded
    const adapter = new FsAdapter(tmpDir, { exclude: ["lib"] });
    const entries = await adapter.list();
    expect(entries).toContain("node_modules/");
    expect(entries.every((e) => !e.startsWith("lib"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe()
// ---------------------------------------------------------------------------

describe("FsAdapter.describe()", () => {
  it("includes the root path", () => {
    const adapter = new FsAdapter(tmpDir);
    expect(adapter.describe()).toContain(tmpDir);
  });

  it("includes the file count (excludes node_modules by default)", () => {
    const adapter = new FsAdapter(tmpDir);
    const desc = adapter.describe();
    // 5 files: index.ts, utils.ts, README.md, lib/helper.ts, lib/math.ts
    expect(desc).toContain("5 files");
  });

  it("includes top-level entries", () => {
    const adapter = new FsAdapter(tmpDir);
    const desc = adapter.describe();
    expect(desc).toContain("index.ts");
    expect(desc).toContain("lib/");
  });

  it("respects include filter in file count", () => {
    const adapter = new FsAdapter(tmpDir, { include: [".ts"] });
    const desc = adapter.describe();
    // Only .ts files: index.ts, utils.ts, lib/helper.ts, lib/math.ts = 4
    expect(desc).toContain("4 files");
  });

  it("handles unreadable root gracefully", () => {
    const adapter = new FsAdapter("/definitely/does/not/exist/at/all");
    const desc = adapter.describe();
    expect(desc).toContain("unable to read directory");
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("FsAdapter.list()", () => {
  it("lists root entries, excluding default exclusions", async () => {
    const adapter = new FsAdapter(tmpDir);
    const entries = await adapter.list();
    expect(entries).toContain("README.md");
    expect(entries).toContain("index.ts");
    expect(entries).toContain("utils.ts");
    expect(entries).toContain("lib/");
    // node_modules excluded
    expect(entries.every((e) => !e.startsWith("node_modules"))).toBe(true);
  });

  it("lists subdirectory contents", async () => {
    const adapter = new FsAdapter(tmpDir);
    const entries = await adapter.list("lib");
    expect(entries).toContain("lib/helper.ts");
    expect(entries).toContain("lib/math.ts");
  });

  it("returns sorted entries", async () => {
    const adapter = new FsAdapter(tmpDir);
    const entries = await adapter.list();
    const sorted = [...entries].sort();
    expect(entries).toEqual(sorted);
  });

  it("respects include filter", async () => {
    const adapter = new FsAdapter(tmpDir, { include: [".ts"] });
    const entries = await adapter.list();
    expect(entries.every((e) => e.endsWith(".ts") || e.endsWith("/"))).toBe(true);
    expect(entries).not.toContain("README.md");
  });

  it("respects custom exclude", async () => {
    const adapter = new FsAdapter(tmpDir, { exclude: ["lib"] });
    const entries = await adapter.list();
    expect(entries.every((e) => !e.startsWith("lib"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe("FsAdapter.read()", () => {
  it("reads file contents", async () => {
    const adapter = new FsAdapter(tmpDir);
    const content = await adapter.read("index.ts");
    expect(content).toContain('export const hello = "world"');
  });

  it("reads a nested file", async () => {
    const adapter = new FsAdapter(tmpDir);
    const content = await adapter.read("lib/helper.ts");
    expect(content).toContain("export const x = 1");
  });

  it("throws on non-existent path", async () => {
    const adapter = new FsAdapter(tmpDir);
    await expect(adapter.read("does-not-exist.ts")).rejects.toThrow();
  });

  it("throws on path traversal attempt", async () => {
    const adapter = new FsAdapter(tmpDir);
    await expect(adapter.read("../../../etc/passwd")).rejects.toThrow(/traversal/i);
  });

  it("throws on symlink pointing outside root", async () => {
    // Create a symlink inside the root that points to a directory outside it
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "budge-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
    const symlinkPath = path.join(tmpDir, "escape");
    fs.symlinkSync(outsideDir, symlinkPath);

    const adapter = new FsAdapter(tmpDir);
    await expect(adapter.read("escape/secret.txt")).rejects.toThrow(/traversal/i);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("throws for a directory path", async () => {
    const adapter = new FsAdapter(tmpDir);
    await expect(adapter.read("lib")).rejects.toThrow(/not a file/i);
  });

  it("returns full content for oversized files", async () => {
    const bigFile = path.join(tmpDir, "big.txt");
    fs.writeFileSync(bigFile, "x".repeat(200 * 1024));
    const adapter = new FsAdapter(tmpDir);
    const content = await adapter.read("big.txt");
    expect(content).toHaveLength(200 * 1024);
    expect(content).not.toContain("[File too large to display");
  });

  it("throws before reading files above the hard limit", async () => {
    const hugeFile = path.join(tmpDir, "huge.txt");
    fs.closeSync(fs.openSync(hugeFile, "w"));
    fs.truncateSync(hugeFile, 10 * 1024 * 1024 + 1);

    const readFileSpy = vi.spyOn(fs.promises, "readFile");
    const adapter = new FsAdapter(tmpDir);

    await expect(adapter.read("huge.txt")).rejects.toThrow(/too large.*10\.0 MiB/i);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("allows files at the hard limit", async () => {
    const limitFile = path.join(tmpDir, "limit.txt");
    fs.closeSync(fs.openSync(limitFile, "w"));
    fs.truncateSync(limitFile, 10 * 1024 * 1024);

    const adapter = new FsAdapter(tmpDir);
    const content = await adapter.read("limit.txt");

    expect(content).toHaveLength(10 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// search() — ripgrep WASM
// ---------------------------------------------------------------------------

describe("FsAdapter.search()", () => {
  it("returns matches for a known string", async () => {
    const adapter = new FsAdapter(tmpDir);
    const results = await adapter.search({ text: "export", k: 10 });
    expect(results.length).toBeGreaterThan(0);
    // Results should be in files that contain "export"
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.content).toContain("export");
      expect(r.score).toBe(1.0);
    }
  });

  it("returns empty array when no matches", async () => {
    const adapter = new FsAdapter(tmpDir);
    const results = await adapter.search({ text: "xyzzy_no_match_zxqwerty", k: 10 });
    expect(results).toEqual([]);
  });

  it("respects the k limit", async () => {
    // index.ts, utils.ts, lib/helper.ts, lib/math.ts all contain "export"
    const adapter = new FsAdapter(tmpDir);
    const results = await adapter.search({ text: "export", k: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("with filters.fixed=true does literal string matching", async () => {
    const adapter = new FsAdapter(tmpDir);
    // Regex special characters are treated as literals
    const results = await adapter.search({ text: "const hello", k: 5, filters: { fixed: true } });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("const hello");
  });

  it("returns match metadata with hitCount and lineNumbers", async () => {
    const adapter = new FsAdapter(tmpDir);
    const results = await adapter.search({ text: "export", k: 5 });
    if (results.length > 0) {
      expect(results[0]!.metadata).toBeDefined();
      expect(typeof (results[0]!.metadata as any).hitCount).toBe("number");
      expect(Array.isArray((results[0]!.metadata as any).lineNumbers)).toBe(true);
    }
  });

  it("describe() mentions search capability", () => {
    const adapter = new FsAdapter(tmpDir);
    const desc = adapter.describe();
    expect(desc).toContain("search_source");
    expect(desc).toContain("fixed");
  });
});
