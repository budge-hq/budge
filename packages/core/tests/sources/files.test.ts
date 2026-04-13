import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { FilesAdapter } from "../../src/sources/files.ts";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let file1: string;
let file2: string;
let file3: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budge-files-test-"));
  file1 = path.join(tmpDir, "auth.md");
  file2 = path.join(tmpDir, "api.md");
  file3 = path.join(tmpDir, "changelog.md");
  fs.writeFileSync(file1, "# Auth\nJWT-based authentication.\n");
  fs.writeFileSync(file2, "# API\nREST API reference.\n");
  fs.writeFileSync(file3, "# Changelog\n## v1.0.0\nInitial release.\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// describe()
// ---------------------------------------------------------------------------

describe("FilesAdapter.describe()", () => {
  it("includes all filenames", () => {
    const adapter = new FilesAdapter([file1, file2, file3]);
    const desc = adapter.describe();
    expect(desc).toContain("auth.md");
    expect(desc).toContain("api.md");
    expect(desc).toContain("changelog.md");
  });

  it("includes the file count", () => {
    const adapter = new FilesAdapter([file1, file2, file3]);
    expect(adapter.describe()).toContain("3 files");
  });

  it("handles a single file", () => {
    const adapter = new FilesAdapter([file1]);
    expect(adapter.describe()).toContain("1 file");
    expect(adapter.describe()).not.toContain("1 files");
  });

  it("handles empty list", () => {
    const adapter = new FilesAdapter([]);
    expect(adapter.describe()).toContain("empty");
  });

  it("truncates preview at 5 files", () => {
    const files = Array.from({ length: 7 }, (_, i) => {
      const p = path.join(tmpDir, `file${i}.md`);
      fs.writeFileSync(p, `file ${i}`);
      return p;
    });
    const adapter = new FilesAdapter(files);
    expect(adapter.describe()).toContain("and 2 more");
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("FilesAdapter.list()", () => {
  it("returns all resolved paths", async () => {
    const adapter = new FilesAdapter([file1, file2]);
    const items = await adapter.list();
    expect(items).toHaveLength(2);
    expect(items).toContain(file1);
    expect(items).toContain(file2);
  });

  it("path argument is ignored (flat source)", async () => {
    const adapter = new FilesAdapter([file1, file2]);
    const withPath = await adapter.list("some/path");
    const withoutPath = await adapter.list();
    expect(withPath).toEqual(withoutPath);
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe("FilesAdapter.read()", () => {
  it("reads file by absolute path", async () => {
    const adapter = new FilesAdapter([file1]);
    const content = await adapter.read(file1);
    expect(content).toContain("JWT-based authentication");
  });

  it("reads file by relative path that resolves to same absolute", async () => {
    const adapter = new FilesAdapter([file2]);
    const content = await adapter.read(file2);
    expect(content).toContain("REST API reference");
  });

  it("throws for a path not in the list", async () => {
    const adapter = new FilesAdapter([file1]);
    await expect(adapter.read(file2)).rejects.toThrow(/not in file list/i);
  });

  it("throws with helpful error listing available files", async () => {
    const adapter = new FilesAdapter([file1]);
    let message = "";
    try {
      await adapter.read(file2);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("auth.md");
  });
});
