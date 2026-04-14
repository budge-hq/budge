import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceAdapter } from "./interface.ts";

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
   * Directory names to always exclude from listings.
   *
   * @default ["node_modules", ".git", "dist", ".next", ".turbo"]
   */
  exclude?: string[];
}

const DEFAULT_EXCLUDE = ["node_modules", ".git", "dist", ".next", ".turbo", "coverage", ".cache"];
const FS_READ_HARD_LIMIT = 10 * 1024 * 1024; // 10 MiB

/**
 * A source adapter that exposes a local filesystem directory.
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
    this.exclude = options.exclude ?? DEFAULT_EXCLUDE;
  }

  describe(): string {
    let fileCount = 0;
    let topLevel: string[] = [];

    try {
      topLevel = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((e) => !this.exclude.includes(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();

      fileCount = this.countFiles(this.root);
    } catch {
      return `Local filesystem at ${this.root} (unable to read directory)`;
    }

    const topStr = topLevel.slice(0, 10).join(", ");
    const more = topLevel.length > 10 ? ` … and ${topLevel.length - 10} more` : "";
    return `Local filesystem at ${this.root} — ${fileCount} file${fileCount === 1 ? "" : "s"}. Top-level: ${topStr}${more}`;
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

  private countFiles(dir: string, depth = 0): number {
    if (depth > 10) return 0;
    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (this.exclude.includes(entry.name)) continue;
        if (entry.isDirectory()) {
          count += this.countFiles(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          if (this.include && !this.include.some((ext) => entry.name.endsWith(ext))) continue;
          count++;
        }
      }
    } catch {
      // ignore unreadable directories
    }
    return count;
  }
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
