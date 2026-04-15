import safeStableStringify from "safe-stable-stringify";
import { estimateTokenCount, splitByTokens } from "tokenx";
import type { BMDocument } from "okapibm25";

// okapibm25 is a CJS module. In ESM interop, the callable function lives at
// module.default.default (the CJS default export wrapped by the ESM loader).
// We resolve it lazily on first use so the module-level import is synchronous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bm25Fn: ((...args: any[]) => number[] | BMDocument[]) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBm25(): Promise<(...args: any[]) => number[] | BMDocument[]> {
  if (_bm25Fn) return _bm25Fn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("okapibm25")) as any;
  _bm25Fn = mod.default?.default ?? mod.default;
  return _bm25Fn!;
}
import type { SearchMatch, SearchQuery, SourceAdapter } from "./interface.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextSourceOptions {
  /**
   * Override the auto-chunking threshold in tokens.
   * Content at or below this threshold is served as a single blob.
   * Default: 4000 tokens.
   */
  chunkThreshold?: number;

  /**
   * Chunking configuration, or `false` to disable chunking entirely.
   *
   * When `false`, the content is always served as a single blob regardless
   * of length.
   */
  chunk?:
    | {
        /**
         * Chunking strategy.
         * - `"fixed"`: split into equal-size token chunks (default)
         * - `"sentences"`: split on sentence boundaries, merge up to chunk size
         * - `"paragraphs"`: split on blank lines, merge up to chunk size
         */
        strategy?: "fixed" | "sentences" | "paragraphs";
        /** Tokens per chunk. Default: 500. */
        size?: number;
        /**
         * Overlap tokens between consecutive chunks. Default: 50.
         * Only applies to the `"fixed"` strategy — boundary-aware strategies
         * (`"sentences"`, `"paragraphs"`) do not support overlap.
         */
        overlap?: number;
      }
    | false;

  /**
   * Custom ranking function for `search()`.
   * Receives all chunks and the query; returns ranked SearchMatch[].
   * Default: BM25 over chunks.
   */
  rank?: (chunks: Chunk[], query: SearchQuery) => Promise<SearchMatch[]>;
}

/** @internal */
export interface Chunk {
  id: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_THRESHOLD = 4000; // tokens
const DEFAULT_CHUNK_SIZE = 500; // tokens per chunk
const DEFAULT_CHUNK_OVERLAP = 50; // overlap tokens

/** Access-pattern note appended to describe() for non-chunked sources. */
const ACCESS_NOTE_INLINE = `Read via read_source with path "text".`;
/** Access-pattern note appended to describe() for chunked sources. */
const ACCESS_NOTE_CHUNKED =
  "List chunks via list_source, search via search_source, or read individual chunks via read_source.";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wraps a string blob as a source. Automatically determines whether to chunk
 * based on content length.
 *
 * **Below threshold (~4000 tokens):** returns a source with only `read()`.
 * The orchestrator reads the whole blob in one call. No `list`, no `search`.
 *
 * **Above threshold:** chunks the content and returns `{ list, read, search }`.
 * The orchestrator can list chunk IDs, read individual chunks, or search across
 * all chunks via BM25.
 *
 * The developer never has to check the length. `source.text(transcript)` works
 * for a 500-token triage note and a 50,000-token complex transcript alike.
 *
 * @example
 * ```ts
 * sources: {
 *   transcript: source.text(visitTranscript),
 *   note: source.text(encounterNote ?? "(no note yet)"),
 * }
 * ```
 */
export function text(content: string, options: TextSourceOptions = {}): SourceAdapter {
  const threshold = options.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD;
  const noChunk = options.chunk === false;

  const tokenCount = estimateTokenCount(content);
  const isChunked = !noChunk && tokenCount > threshold;

  if (!isChunked) {
    // Simple blob — expose only read()
    return {
      describe: () =>
        `Inline text (~${tokenCount} token${tokenCount === 1 ? "" : "s"}). ${ACCESS_NOTE_INLINE}`,

      read: async (path: string) => {
        if (path !== "text") {
          throw new Error(`Unknown path: "${path}". This source has one path: "text".`);
        }
        return content;
      },
    };
  }

  // Chunked — build chunks eagerly at construction time
  const chunks = buildChunks(content, options);
  const bm25Index = buildBm25Index(chunks);

  return {
    describe: () => {
      const avgTokens = Math.round(tokenCount / chunks.length);
      return (
        `Chunked text (${chunks.length} chunk${chunks.length === 1 ? "" : "s"}, ` +
        `~${avgTokens} tokens each, ~${tokenCount} tokens total). ` +
        ACCESS_NOTE_CHUNKED
      );
    },

    list: async (_path?: string) => chunks.map((c) => c.id),

    read: async (path: string) => {
      const chunk = chunks.find((c) => c.id === path);
      if (!chunk) {
        const available = chunks.map((c) => c.id).join(", ");
        throw new Error(`Unknown chunk ID: "${path}". Available: ${available}`);
      }
      return chunk.content;
    },

    search: async (query: SearchQuery) => {
      if (options.rank) {
        return options.rank(chunks, query);
      }
      return await bm25Search(bm25Index, chunks, query);
    },
  };
}

// ---------------------------------------------------------------------------
// json factory
// ---------------------------------------------------------------------------

/**
 * Wraps a JSON-serializable value as a source.
 *
 * Equivalent to `source.text(safeStableStringify(value, null, 2))` but with a
 * richer auto-generated `describe()` that names the top-level keys. Handles
 * circular references safely via `safe-stable-stringify`.
 *
 * Chunking and search follow the same auto-threshold logic as `source.text`:
 * small objects are served as a single blob; large ones are chunked with BM25
 * search enabled.
 *
 * @example
 * ```ts
 * sources: {
 *   patient: source.json(patientRecord),
 * }
 * // describe() → "JSON object with keys: id, name, dob, medications, allergies (~492 tokens)."
 * ```
 */
export function json(value: unknown, options: TextSourceOptions = {}): SourceAdapter {
  const serialized = safeStableStringify(value, undefined, 2) ?? "null";
  const tokenCount = estimateTokenCount(serialized);

  const label = valueLabel(value);
  const isPlainObject = label === "JSON object";

  const MAX_KEYS_IN_DESCRIBE = 20;
  const topLevelKeys = isPlainObject ? topKeys(value) : [];
  const keysSummary =
    topLevelKeys.length === 0
      ? ""
      : topLevelKeys.length <= MAX_KEYS_IN_DESCRIBE
        ? `with keys: ${topLevelKeys.join(", ")} `
        : `with keys: ${topLevelKeys.slice(0, MAX_KEYS_IN_DESCRIBE).join(", ")} … and ${topLevelKeys.length - MAX_KEYS_IN_DESCRIBE} more `;

  // Build the underlying text adapter — it handles all chunking and search.
  const inner = text(serialized, options);
  // Determine which access note to append based on the same chunking decision
  // text() made internally — avoids coupling to text()'s describe() format.
  const threshold = options.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD;
  const isChunked = options.chunk !== false && tokenCount > threshold;
  const accessNote = isChunked ? ACCESS_NOTE_CHUNKED : ACCESS_NOTE_INLINE;

  return {
    ...inner,
    describe: () => {
      const base = `${label} ${keysSummary}(~${tokenCount} token${tokenCount === 1 ? "" : "s"}).`;
      return `${base} ${accessNote}`;
    },
  };
}

/** Returns a human-readable type label for the top-level JSON value. */
function valueLabel(value: unknown): string {
  if (Array.isArray(value)) return "JSON array";
  if (value === null || typeof value !== "object") return "JSON primitive";
  return "JSON object";
}

/**
 * Returns the top-level keys of a value if it is a plain object,
 * or an empty array for arrays, primitives, and null.
 */
function topKeys(value: unknown): string[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

type ChunkConfig = Exclude<TextSourceOptions["chunk"], false | undefined>;

function buildChunks(content: string, options: TextSourceOptions): Chunk[] {
  const chunkOpts: ChunkConfig = options.chunk !== false && options.chunk ? options.chunk : {};
  const strategy = chunkOpts.strategy ?? "fixed";
  const chunkSize = chunkOpts.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = chunkOpts.overlap ?? DEFAULT_CHUNK_OVERLAP;

  let rawChunks: string[];

  switch (strategy) {
    case "fixed":
      rawChunks = splitByTokens(content, chunkSize, { overlap });
      break;
    case "sentences":
      rawChunks = chunkBySentences(content, chunkSize);
      break;
    case "paragraphs":
      rawChunks = chunkByParagraphs(content, chunkSize);
      break;
  }

  return rawChunks
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c, i) => ({ id: `chunk:${i}`, content: c }));
}

/**
 * Split on sentence boundaries (`.`, `!`, `?` followed by whitespace or end),
 * then merge small segments up to `maxTokens`.
 */
function chunkBySentences(content: string, maxTokens: number): string[] {
  // Split on sentence-ending punctuation followed by space/newline or end of string
  const sentences = content.split(/(?<=[.!?])\s+/);
  return mergeSegments(sentences, maxTokens);
}

/**
 * Split on blank lines, then merge small paragraphs up to `maxTokens`.
 * Paragraph boundaries are preserved as `\n\n` in the merged output.
 */
function chunkByParagraphs(content: string, maxTokens: number): string[] {
  const paragraphs = content.split(/\n\s*\n+/);
  return mergeSegments(paragraphs, maxTokens, "\n\n");
}

/**
 * Greedily merge segments until the next one would exceed `maxTokens`,
 * then flush and start a new chunk.
 *
 * @param sep - Separator used when joining segments within the same chunk.
 *              Defaults to `" "`. Pass `"\n\n"` for paragraph-aware chunking.
 */
function mergeSegments(segments: string[], maxTokens: number, sep = " "): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentTokens = 0;

  for (const segment of segments) {
    const segTokens = estimateTokenCount(segment);

    if (currentTokens + segTokens > maxTokens && current.length > 0) {
      chunks.push(current);
      current = segment;
      currentTokens = segTokens;
    } else {
      current = current.length > 0 ? `${current}${sep}${segment}` : segment;
      currentTokens += segTokens;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

interface Bm25Index {
  documents: string[];
  /** Maps document content → its index in `chunks`. First occurrence wins for duplicates. */
  docIndexMap: Map<string, number>;
}

function tokenizeForBm25(text: string): string[] {
  // Lowercase, split on non-alphanumeric boundaries
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function buildBm25Index(chunks: Chunk[]): Bm25Index {
  const documents = chunks.map((c) => c.content);
  // First occurrence wins for duplicate content (e.g. identical overlap chunks):
  // iterate in reverse so earlier indices overwrite later ones in the Map.
  const docIndexMap = new Map<string, number>();
  for (let i = documents.length - 1; i >= 0; i--) {
    docIndexMap.set(documents[i]!, i);
  }
  return { documents, docIndexMap };
}

async function bm25Search(
  index: Bm25Index,
  chunks: Chunk[],
  query: SearchQuery,
): Promise<SearchMatch[]> {
  if (chunks.length === 0) return [];

  const keywords = tokenizeForBm25(query.text);
  if (keywords.length === 0) return [];

  const BM25 = await getBm25();

  // Use okapibm25 with a sorter to get ranked BMDocument[]
  const results = BM25(
    index.documents,
    keywords,
    { b: 0.75, k1: 1.2 },
    // Sort descending by score
    (a: BMDocument, b: BMDocument) => b.score - a.score,
  ) as BMDocument[];

  const matches: SearchMatch[] = [];
  for (const r of results) {
    if (r.score <= 0) break; // results are sorted descending — first zero means all remaining are zero
    if (matches.length >= query.k) break;
    const idx = index.docIndexMap.get(r.document) ?? -1;
    if (idx === -1) continue; // library returned an unrecognised document — skip rather than misroute
    const chunk = chunks[idx]!;
    matches.push({ id: chunk.id, content: chunk.content, score: r.score });
  }
  return matches;
}
