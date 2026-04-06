import { encode } from "@toon-format/toon";
import { estimateTokenCount } from "tokenx";

/**
 * Serialize a value to a token-efficient string for prompt construction.
 * Strings pass through unchanged. Structured data is encoded with TOON.
 */
export function serialize(value: unknown, label?: string): string {
  if (value === null || value === undefined) return "";

  const encoded = typeof value === "string" ? value : encode(value as Parameters<typeof encode>[0]);

  return label ? `${label}:\n${encoded}` : encoded;
}

export function estimateTokens(text: string): number {
  return estimateTokenCount(text);
}
