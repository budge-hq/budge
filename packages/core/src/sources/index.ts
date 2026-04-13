export type { SourceAdapter } from "./interface.ts";
export { FsAdapter, type FsAdapterOptions } from "./fs.ts";
export { FilesAdapter } from "./files.ts";
export { ConversationAdapter, type ConversationMessage } from "./conversation.ts";

import { FsAdapter, type FsAdapterOptions } from "./fs.ts";
import { FilesAdapter } from "./files.ts";
import { ConversationAdapter, type ConversationMessage } from "./conversation.ts";

/**
 * Built-in source adapters.
 *
 * @example
 * ```ts
 * import { source } from "@budge/core"
 *
 * source.fs("./src")
 * source.files(["./docs/auth.md"])
 * source.conversation(messages)
 * ```
 */
export const source = {
  /**
   * Expose a local filesystem directory as a navigable source.
   *
   * The agent can list directories and read individual files.
   * Follows only what the agent explicitly requests — no upfront
   * bulk reading.
   *
   * @param rootPath - Path to the directory root.
   * @param options  - Optional configuration (maxFileSize, include, exclude).
   */
  fs: (rootPath: string, options?: FsAdapterOptions): FsAdapter => new FsAdapter(rootPath, options),

  /**
   * Expose an explicit list of files as a source.
   *
   * Useful for targeted document sets: changelogs, specs, READMEs.
   *
   * @param paths - Absolute or relative paths to the files.
   */
  files: (paths: string[]): FilesAdapter => new FilesAdapter(paths),

  /**
   * Expose a conversation history as a navigable source.
   *
   * Messages are addressable by index or slice (`"5"`, `"5:10"`, `":10"`, `"20:"`).
   *
   * @param messages - Array of conversation messages.
   */
  conversation: (messages: ConversationMessage[]): ConversationAdapter =>
    new ConversationAdapter(messages),
} as const;
