import * as fs from "node:fs";
import * as path from "node:path";
import { ripgrep } from "ripgrep";
import type { SearchMatch, SearchQuery, SourceAdapter } from "./interface.ts";

/**
 * Options for the filesystem source adapter.
 */
export interface FsAdapterOptions {
  /**
   * File extensions to include when listing. If omitted, all files
   * are included. Use this to scope the agent to relevant files only.
   *
   * @example [".ts", ".tsx", ".md"]
   */
  include?: string[];

  /**
   * File or directory names to exclude. When provided, this list
   * *replaces* the default exclusions entirely.
   *
   * @default DEFAULT_EXCLUDE (for example: node_modules, .git, dist, coverage, .cache, lockfiles, OS artifacts)
   */
  exclude?: string[];

  /**
   * Additional file or directory names to exclude, merged with the defaults
   * (or with `exclude` if provided). Unlike `exclude`, this never
   * replaces defaults — it only adds to them.
   *
   * @example ["build", ".venv"]
   */
  excludePatterns?: string[];
}

const DEFAULT_EXCLUDE = [
  // Dependency directories
  "node_modules",
  "bower_components",
  "vendor",
  // Build outputs
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  // Python
  "venv",
  ".venv",
  "__pycache__",
  ".tox",
  // Version control & tooling
  ".git",
  ".cache",
  ".budge",
  // Lock files (filenames, not directories)
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "uv.lock",
  // OS artifacts
  ".DS_Store",
  "Thumbs.db",
];

const FS_READ_HARD_LIMIT = 10 * 1024 * 1024; // 10 MiB

/**
 * A source adapter that exposes a local filesystem directory.
 *
 * Supports navigable list/read access and ripgrep-powered search.
 *
 * @example
 * ```ts
 * const codebase = source.fs("./src")
 * const codebase = source.fs("./src", { include: [".ts", ".tsx"] })
 * ```
 */
export class FsAdapter implements SourceAdapter {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly include: string[] | undefined;
  private readonly exclude: string[];

  constructor(rootPath: string, options: FsAdapterOptions = {}) {
    this.root = path.resolve(rootPath);
    // Resolve the root's own symlinks once at construction so the realpath
    // check in resolve() compares against the true on-disk path.
    // Fall back to the string-resolved path if the root doesn't exist yet.
    try {
      this.realRoot = fs.realpathSync.native(this.root);
    } catch {
      this.realRoot = this.root;
    }
    this.include = options.include;
    const base = options.exclude ?? DEFAULT_EXCLUDE;
    this.exclude = options.excludePatterns ? [...base, ...options.excludePatterns] : base;
  }

  describe(): string {
    let topLevel: string[] = [];
    let fileCount = 0;
    let fileCountCapped = false;

    try {
      topLevel = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((e) => !this.exclude.includes(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();

      ({ count: fileCount, capped: fileCountCapped } = this.countFiles(this.root));
    } catch {
      return `Local filesystem at ${this.root} (unable to read directory)`;
    }

    const countStr = fileCountCapped ? `~${fileCount}+` : `${fileCount}`;
    const topStr = topLevel.slice(0, 10).join(", ");
    const more = topLevel.length > 10 ? ` … and ${topLevel.length - 10} more` : "";
    return (
      `Local filesystem at ${this.root} — ${countStr} file${fileCount === 1 ? "" : "s"}. ` +
      `Top-level: ${topStr}${more}. ` +
      `Searchable via search_source (regex or literal). Use filters: { fixed: true } for literal string search.`
    );
  }

  async list(dirPath?: string): Promise<string[]> {
    const target = dirPath ? await this.resolve(dirPath) : this.root;

    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (this.exclude.includes(entry.name)) continue;

      const rel = dirPath ? `${dirPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        results.push(`${rel}/`);
      } else if (entry.isFile()) {
        if (this.include && !this.include.some((ext) => entry.name.endsWith(ext))) continue;
        results.push(rel);
      }
    }

    return results.sort();
  }

  async read(filePath: string): Promise<string> {
    const absolute = await this.resolve(filePath);
    const stat = await fs.promises.stat(absolute);

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    // Prevent loading arbitrarily large files into memory. Display truncation
    // happens later in the tool layer; this cap only guards the raw read.
    if (stat.size > FS_READ_HARD_LIMIT) {
      throw new Error(
        `File too large to read: ${filePath} (${formatBytes(stat.size)}, limit ${formatBytes(FS_READ_HARD_LIMIT)})`,
      );
    }

    return fs.promises.readFile(absolute, "utf8");
  }

  async search(query: SearchQuery): Promise<SearchMatch[]> {
    // --max-count limits matches *per file*. A low value (5) keeps the
    // buffered stdout proportional to k files × 5 lines, avoiding hundreds of
    // MB for broad queries on large repos. Five context lines per file is
    // enough for the orchestrator to judge relevance.
    const args: string[] = ["--json", "--max-count", "5"];

    if (query.filters?.fixed === true) {
      args.push("--fixed-strings");
    }

    if (this.include && this.include.length > 0) {
      for (const ext of this.include) {
        args.push("--glob", `*${ext}`);
      }
    }

    for (const name of new Set(this.exclude)) {
      args.push("--glob", `!${name}`);
      args.push("--glob", `!**/${name}`);
      args.push("--glob", `!${name}/**`);
      args.push("--glob", `!**/${name}/**`);
    }

    // ripgrep WASM works relative to its preopens. We pass "." as the search
    // path (which maps to this.root via the preopen) so all returned paths
    // are relative and consistent.
    args.push("--", query.text, ".");

    let stdout = "";
    try {
      const result = await ripgrep(args, {
        buffer: true,
        preopens: { ".": this.root },
      });
      // Exit code 0 = matches, 1 = no matches, 2 = error
      if (result.code === 2) return [];
      stdout = result.stdout;
    } catch {
      return [];
    }

    return parseRipgrepJson(stdout, query.k);
  }

  /**
   * Resolves a relative path against the root, guarding against traversal.
   *
   * Two-stage check:
   * 1. String check on the resolved path — catches simple `../` traversal.
   * 2. `realpath` check — dereferences symlinks and re-validates, catching
   *    symlinks that point outside the root (e.g. `lib -> /etc`).
   *
   * Returns the original `absolute` path (not the realpath) so that listings
   * and tool call results use the correct relative labels.
   */
  private async resolve(rel: string): Promise<string> {
    const absolute = path.resolve(this.root, rel);
    if (!absolute.startsWith(this.root + path.sep) && absolute !== this.root) {
      throw new Error(`Path traversal detected: ${rel}`);
    }
    // Dereference symlinks and re-check against the real root — catches
    // symlinks inside the tree that point outside it (e.g. lib -> /etc).
    const real = await fs.promises.realpath(absolute).catch(() => absolute);
    if (!real.startsWith(this.realRoot + path.sep) && real !== this.realRoot) {
      throw new Error(`Path traversal detected: ${rel}`);
    }
    return absolute;
  }

  /**
   * Count files up to `MAX_COUNT_DEPTH` levels deep to avoid blocking the
   * event loop on large trees. Returns `capped: true` when the depth limit
   * was reached so `describe()` can signal an approximate count.
   */
  private countFiles(dir: string, depth = 0): { count: number; capped: boolean } {
    const MAX_COUNT_DEPTH = 3;
    if (depth > MAX_COUNT_DEPTH) return { count: 0, capped: true };
    let count = 0;
    let capped = false;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (this.exclude.includes(entry.name)) continue;
        if (entry.isDirectory()) {
          const child = this.countFiles(path.join(dir, entry.name), depth + 1);
          count += child.count;
          if (child.capped) capped = true;
        } else if (entry.isFile()) {
          if (this.include && !this.include.some((ext) => entry.name.endsWith(ext))) continue;
          count++;
        }
      }
    } catch {
      // ignore unreadable directories
    }
    return { count, capped };
  }
}

// ---------------------------------------------------------------------------
// ripgrep JSON output parsing
// ---------------------------------------------------------------------------

interface RgMatchData {
  path: { text: string };
  lines: { text: string };
  line_number: number;
}

interface RgJsonLine {
  type: string;
  data: RgMatchData;
}

/**
 * Parse ripgrep's `--json` NDJSON output into SearchMatch[].
 *
 * Groups all matching lines by file, returns up to `k` files,
 * each represented as a single SearchMatch with all hit lines joined.
 */
function parseRipgrepJson(stdout: string, k: number): SearchMatch[] {
  // Group hits by file path
  const byFile = new Map<string, { lines: string[]; lineNumbers: number[] }>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: RgJsonLine;
    try {
      parsed = JSON.parse(trimmed) as RgJsonLine;
    } catch {
      continue;
    }

    if (parsed.type !== "match") continue;

    const filePath = parsed.data.path.text;
    if (!filePath) continue; // non-UTF-8 path — skip rather than emit id: undefined
    const matchLine = (parsed.data.lines.text ?? "").trimEnd();
    const lineNum = parsed.data.line_number;

    const existing = byFile.get(filePath);
    if (existing) {
      existing.lines.push(matchLine);
      existing.lineNumbers.push(lineNum);
    } else {
      byFile.set(filePath, { lines: [matchLine], lineNumbers: [lineNum] });
    }
  }

  const results: SearchMatch[] = [];
  for (const [filePath, { lines, lineNumbers }] of byFile) {
    if (results.length >= k) break;
    results.push({
      id: filePath,
      content: lines.join("\n"),
      score: 1.0,
      metadata: {
        file: filePath,
        hitCount: lines.length,
        lineNumbers,
      },
    });
  }

  return results;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${bytes} B`;
}
