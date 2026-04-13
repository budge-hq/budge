export type { SourceAdapter } from "./interface.ts";
export { FsAdapter, type FsAdapterOptions } from "./fs.ts";
export { FilesAdapter } from "./files.ts";
export { ConversationAdapter, type ConversationMessage } from "./conversation.ts";
export { TextAdapter } from "./text.ts";
export {
  McpAdapter,
  type McpLikeClient,
  type McpSourceOptions,
  type ToolDefinition,
} from "./mcp.ts";

import { FsAdapter, type FsAdapterOptions } from "./fs.ts";
import { FilesAdapter } from "./files.ts";
import { ConversationAdapter, type ConversationMessage } from "./conversation.ts";
import { TextAdapter } from "./text.ts";
import { McpAdapter, type McpLikeClient, type McpSourceOptions } from "./mcp.ts";

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
 * source.text("inline notes")
 * source.mcp(client, { tools: ["get_patient"] })
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

  /**
   * Expose a single inline string as a navigable source.
   *
   * Useful for passing notes, summaries, prompts, or arbitrary text blobs
   * into the runtime without creating a file.
   *
   * @param text - The inline text to expose.
   */
  text: (text: string): TextAdapter => new TextAdapter(text),

  /**
   * Expose an MCP client's tool catalog as a read-only source.
   *
   * The agent can list exposed tools and read per-tool metadata, but it
   * cannot invoke MCP tools through the source API. Options use one of two
   * modes: exact allowlist mode via `tools`, or filter mode via
   * `readonly`/`allow`/`deny`.
   *
   * @param client  - MCP client exposing `listTools()` or `tools()`.
   * @param options - Optional exposure filters. Defaults to `readonly: true`.
   */
  mcp: <
    const Allow extends readonly string[] | undefined = undefined,
    const Deny extends readonly string[] | undefined = undefined,
  >(
    client: McpLikeClient,
    options?: McpSourceOptions<Allow, Deny>,
  ): McpAdapter => new McpAdapter(client, options),
} as const;
