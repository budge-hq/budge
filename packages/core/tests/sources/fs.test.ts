import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
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

  it("throws for a directory path", async () => {
    const adapter = new FsAdapter(tmpDir);
    await expect(adapter.read("lib")).rejects.toThrow(/not a file/i);
  });

  it("returns truncation notice for oversized files", async () => {
    const bigFile = path.join(tmpDir, "big.txt");
    // Write just over the limit
    fs.writeFileSync(bigFile, "x".repeat(200 * 1024));
    const adapter = new FsAdapter(tmpDir, { maxFileSize: 128 * 1024 });
    const content = await adapter.read("big.txt");
    expect(content).toContain("[File too large to display");
  });
});
