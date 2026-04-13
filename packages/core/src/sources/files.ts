import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceAdapter } from "./interface.ts";

/**
 * A source adapter for an explicit, pre-defined list of files.
 *
 * Unlike `source.fs`, this adapter does not traverse directories —
 * it exposes exactly the files you specify. Useful for targeted
 * document sets: changelogs, READMEs, spec files, and so on.
 *
 * @example
 * ```ts
 * const docs = source.files(["./docs/auth.md", "./docs/api.md"])
 * ```
 */
export class FilesAdapter implements SourceAdapter {
  private readonly paths: string[];
  private readonly set: Set<string>;

  constructor(paths: string[]) {
    // Resolve all paths immediately so relative paths are stable
    // regardless of CWD changes later.
    this.paths = paths.map((p) => path.resolve(p));
    this.set = new Set(this.paths);
  }

  describe(): string {
    const names = this.paths.map((p) => path.basename(p));
    const count = names.length;

    if (count === 0) return "Explicit file list — empty";

    const preview = names.slice(0, 5).join(", ");
    const more = count > 5 ? ` … and ${count - 5} more` : "";
    return `Explicit file list (${count} file${count === 1 ? "" : "s"}): ${preview}${more}`;
  }

  async list(_path?: string): Promise<string[]> {
    // FilesAdapter is flat — path is ignored, full list is always returned.
    return [...this.paths];
  }

  async read(filePath: string): Promise<string> {
    // Accept both the resolved absolute path and the original path.
    const absolute = path.resolve(filePath);

    if (!this.set.has(absolute)) {
      throw new Error(
        `Path not in file list: ${filePath}\n` +
          `Available: ${[...this.paths].map((p) => path.basename(p)).join(", ")}`,
      );
    }

    return fs.readFileSync(absolute, "utf8");
  }
}
