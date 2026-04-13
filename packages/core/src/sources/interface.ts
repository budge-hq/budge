/**
 * The extension contract for source adapters.
 *
 * Implement this interface to plug any data source into the runtime.
 * The runtime never touches your data directly — it navigates through
 * these three operations as directed by the root agent.
 *
 * @example
 * ```ts
 * import type { SourceAdapter } from "@budge/core"
 *
 * class GitHubAdapter implements SourceAdapter {
 *   constructor(private repo: string) {}
 *
 *   describe() {
 *     return `GitHub repository ${this.repo} — files accessible via the GitHub API`
 *   }
 *
 *   async list(path?: string) {
 *     // return directory contents at path
 *   }
 *
 *   async read(path: string) {
 *     // return file contents at path
 *   }
 * }
 * ```
 */
export interface SourceAdapter {
  /**
   * Returns a plain-language description of what this source contains
   * and how to navigate it. Used by the root agent to decide whether
   * and how to explore this source.
   *
   * Should be one or two sentences — concise but informative.
   */
  describe(): string;

  /**
   * Lists items available at an optional path.
   *
   * For filesystem-like sources: returns directory entries.
   * For flat sources: returns all available keys/identifiers.
   * For sequential sources: returns indices as strings.
   *
   * @param path - Optional sub-path within the source. Omit for the root listing.
   */
  list(path?: string): Promise<string[]>;

  /**
   * Reads the content at a specific path and returns it as a string.
   *
   * @param path - A path previously returned by `list()`, or a known address.
   */
  read(path: string): Promise<string>;
}
