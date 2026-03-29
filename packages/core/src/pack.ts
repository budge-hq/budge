import { encode } from "@toon-format/toon";
import { estimateTokenCount } from "tokenx";
import { greedyScore, resolveStrategy } from "./strategies.ts";
import type { BudgetConfig, BudgetStrategyFn, PackedResult, RagItems } from "./types.ts";

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

interface NormalizedBudget {
  maxTokens: number;
  strategyFn: BudgetStrategyFn;
  strategyName: string;
}

/**
 * Normalize the budget field from policies into a consistent shape.
 * Accepts the old `number` shorthand or the new `BudgetConfig` object.
 */
export function normalizeBudget(field: number | BudgetConfig | undefined): NormalizedBudget {
  if (field === undefined) {
    return { maxTokens: Infinity, strategyFn: greedyScore, strategyName: "greedy_score" };
  }
  if (typeof field === "number") {
    return { maxTokens: field, strategyFn: greedyScore, strategyName: "greedy_score" };
  }
  const strategyFn = resolveStrategy(field.strategy);
  const strategyName =
    field.strategy === undefined
      ? "greedy_score"
      : typeof field.strategy === "function"
        ? "custom"
        : field.strategy.type;
  return { maxTokens: field.maxTokens, strategyFn, strategyName };
}

/**
 * Pack chunks from a RAG items result into a token budget.
 * Delegates to the provided strategy function (defaults to greedy-by-score).
 */
export function packChunks(
  chunks: RagItems,
  remainingBudget: number,
  strategy?: BudgetStrategyFn,
): PackedResult {
  const fn = strategy ?? greedyScore;
  return fn(chunks.items, { budget: remainingBudget, estimateTokens: estimateTokenCount });
}
