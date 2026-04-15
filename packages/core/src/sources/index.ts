export type { SourceAdapter, SearchQuery, SearchMatch } from "./interface.ts";
export { FsAdapter, type FsAdapterOptions } from "./fs.ts";
export { text, json, type TextSourceOptions, type Chunk } from "./text.ts";

import { FsAdapter, type FsAdapterOptions } from "./fs.ts";
import { text, json, type TextSourceOptions } from "./text.ts";

/**
 * Built-in source factories.
 *
 * @example
 * ```ts
 * import { source } from "@budge/core"
 *
 * source.fs("./src")
 * source.text("inline notes")
 * source.json({ foo: "bar" })
 *
 * // Plain objects work for everything else:
 * const db: SourceAdapter = {
 *   describe: () => "Patient database.",
 *   tools: () => ({ search_patients: tool({ ... }) }),
 * }
 * ```
 */
export const source = {
  /**
   * Expose a local filesystem directory as a navigable source.
   *
   * The agent can list directories, read individual files, and search
   * file contents using ripgrep (WASM — no binary install required).
   *
   * @param rootPath - Path to the directory root.
   * @param options  - Optional configuration (include, exclude, excludePatterns).
   */
  fs: (rootPath: string, options?: FsAdapterOptions): FsAdapter => new FsAdapter(rootPath, options),

  /**
   * Expose a string blob as a source.
   *
   * Automatically determines whether to chunk based on content length.
   * Below ~4000 tokens: returns `{ read }` — one call reads the whole blob.
   * Above threshold: chunks and returns `{ list, read, search }` with BM25 search.
   *
   * @param content - The text content to expose.
   * @param options - Optional chunking and ranking configuration.
   */
  text: (content: string, options?: TextSourceOptions) => text(content, options),

  /**
   * Expose a JSON-serializable value as a source.
   *
   * Equivalent to `source.text(JSON.stringify(value, null, 2))` but with a
   * richer auto-generated `describe()` that lists the top-level keys. Handles
   * circular references safely.
   *
   * Chunking and search follow the same auto-threshold logic as `source.text`.
   *
   * @param value   - Any JSON-serializable value.
   * @param options - Optional chunking and ranking configuration.
   *
   * @example
   * ```ts
   * sources: {
   *   patient: source.json(patientRecord),
   * }
   * // describe() → "JSON object with keys: id, name, dob, medications (~492 tokens)."
   * ```
   */
  json: (value: unknown, options?: TextSourceOptions) => json(value, options),
} as const;
