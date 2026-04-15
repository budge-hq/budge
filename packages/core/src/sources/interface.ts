import type { Tool } from "ai";

/**
 * A natural-language query for semantic or relevance-based search.
 */
export interface SearchQuery {
  /** Natural language description of what to find. */
  text: string;
  /** How many results to return. */
  k: number;
  /** Source-specific metadata filters. Interpreted by the search implementation. */
  filters?: Record<string, unknown>;
}

/**
 * A single result from a search operation.
 */
export interface SearchMatch {
  /** Stable identifier for this result — can be passed to read() if the source supports it. */
  id: string;
  /** The matched content. */
  content: string;
  /** Relevance score. Higher is more relevant. */
  score: number;
  /** Source-specific metadata (e.g. file path, line number, date). */
  metadata?: Record<string, unknown>;
}

/**
 * The extension contract for source adapters.
 *
 * Only `describe()` is required. Implement whichever subset of the optional
 * methods matches the underlying shape of your data source. The orchestrator
 * receives tools derived from whichever methods you implement — nothing more.
 *
 * Access patterns:
 * - Path-based: implement `list` and/or `read`
 * - Query-based: implement `search`
 * - Capability-based: implement `tools`
 *
 * @example Plain object with search (e.g. a vector store):
 * ```ts
 * const notes: SourceAdapter = {
 *   describe: () => "Clinical notes, searchable by semantic similarity.",
 *   search: async (query) => myVectorSearch(query),
 *   read: async (id) => fetchById(id),
 * }
 * ```
 *
 * @example Plain object with tools (e.g. a database):
 * ```ts
 * // Use `satisfies SourceAdapter` (not `: SourceAdapter`) to preserve specific
 * // tool input types for fully-typed onToolCall events.
 * const db = {
 *   describe: () => "Patient database. Use the provided tools to query it.",
 *   tools: () => ({
 *     search_patients: tool({ ... }),
 *     get_patient: tool({ ... }),
 *   }),
 * } satisfies SourceAdapter;
 * ```
 */
export interface SourceAdapter {
  /**
   * Required. Describe what this source contains and how to query it.
   *
   * This text is injected into the orchestrator's system prompt — write it
   * for the LLM, not for a human developer. Include: what data is here,
   * which access patterns are available, and any source-specific filter keys
   * or schema notes the orchestrator needs to use this source effectively.
   */
  describe(): string;

  /**
   * Optional. List navigable paths or IDs at this location.
   *
   * Omit `path` to list the root. For filesystem-like sources: returns
   * directory entries. For chunked text: returns chunk IDs.
   */
  list?(path?: string): Promise<string[]>;

  /**
   * Optional. Read content at a specific path or ID.
   *
   * For filesystem sources: returns file contents. For chunked text: returns
   * the chunk. For search sources with ID-based lookup: returns the document.
   */
  read?(path: string): Promise<string>;

  /**
   * Optional. Search for content by semantic or relevance query.
   *
   * The implementation decides how ranking works — vector similarity, BM25,
   * hybrid, or anything else. The `filters` field is source-specific; document
   * available filter keys in `describe()` so the orchestrator learns about them.
   */
  search?(query: SearchQuery): Promise<SearchMatch[]>;

  /**
   * Optional. Contribute domain-specific tools to the orchestrator.
   *
   * Keys become tool names, prefixed with the source name at registration.
   * A source named `"db"` contributing `"search_patients"` registers as
   * `"db.search_patients"`.
   *
   * Use AI SDK `tool()` for static tools (compile-time Zod schemas) or
   * `dynamicTool()` for runtime-discovered tools (e.g. from MCP servers).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?(): Record<string, Tool<any, any>>;
}
