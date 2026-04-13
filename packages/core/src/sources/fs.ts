import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceAdapter } from "./interface.ts";

/**
 * Options for the filesystem source adapter.
 */
export interface FsAdapterOptions {
  /**
   * Maximum file size in bytes to read. Files exceeding this limit
   * return a truncation notice instead of their contents.
   *
   * @default 131072 (128 KiB)
   */
  maxFileSize?: number;

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

const DEFAULT_MAX_FILE_SIZE = 128 * 1024; // 128 KiB
const DEFAULT_EXCLUDE = ["node_modules", ".git", "dist", ".next", ".turbo", "coverage", ".cache"];

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
  private readonly maxFileSize: number;
  private readonly include: string[] | undefined;
  private readonly exclude: string[];

  constructor(rootPath: string, options: FsAdapterOptions = {}) {
    this.root = path.resolve(rootPath);
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
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
    const target = dirPath ? this.resolve(dirPath) : this.root;

    const entries = fs.readdirSync(target, { withFileTypes: true });
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
    const absolute = this.resolve(filePath);
    const stat = fs.statSync(absolute);

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    if (stat.size > this.maxFileSize) {
      return [
        `[File too large to display: ${filePath}]`,
        `Size: ${(stat.size / 1024).toFixed(1)} KiB (limit: ${(this.maxFileSize / 1024).toFixed(0)} KiB)`,
        `Use list() to explore subdirectories or request a specific section.`,
      ].join("\n");
    }

    return fs.readFileSync(absolute, "utf8");
  }

  /**
   * Resolves a relative path against the root, guarding against traversal.
   */
  private resolve(rel: string): string {
    const absolute = path.resolve(this.root, rel);
    if (!absolute.startsWith(this.root + path.sep) && absolute !== this.root) {
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
