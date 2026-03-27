import { encode } from "@toon-format/toon";
import { estimateTokenCount } from "tokenx";
import type { Chunk, ChunkRecord, Chunks } from "./types.ts";

interface PackedChunks {
  included: Chunk[];
  records: ChunkRecord[];
  tokensUsed: number;
}

/**
 * Serialize a value to a token-efficient string for prompt construction.
 * Strings pass through unchanged. Structured data (objects, arrays) is encoded
 * using TOON (Token-Oriented Object Notation), which achieves ~40% fewer tokens
 * than JSON with equal or better model accuracy.
 * An optional label adds a section header.
 */
export function serialize(value: unknown, label?: string): string {
  if (value === null || value === undefined) return "";
  let encoded: string;
  if (typeof value === "string") {
    encoded = value;
  } else {
    encoded = encode(value as Parameters<typeof encode>[0]);
  }
  return label ? `${label}:\n${encoded}` : encoded;
}

export function estimateTokens(text: string): number {
  return estimateTokenCount(text);
}

/**
 * Pack chunks from a Chunks result into a token budget.
 * Chunks are sorted by score descending, then fit greedily until budget is exhausted.
 */
export function packChunks(chunks: Chunks, remainingBudget: number): PackedChunks {
  const sorted = [...chunks.items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const included: Chunk[] = [];
  const records: ChunkRecord[] = [];
  let tokensUsed = 0;

  for (const chunk of sorted) {
    const tokens = estimateTokenCount(chunk.content);

    if (tokensUsed + tokens <= remainingBudget) {
      included.push(chunk);
      tokensUsed += tokens;
      records.push({
        content: chunk.content,
        score: chunk.score,
        included: true,
      });
    } else {
      records.push({
        content: chunk.content,
        score: chunk.score,
        included: false,
        reason: "over_budget",
      });
    }
  }

  return { included, records, tokensUsed };
}
