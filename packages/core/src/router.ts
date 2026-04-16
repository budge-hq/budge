import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { SourceAdapter } from "./sources/interface.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Decomposition = "atomic" | "aggregative" | "sequential" | "synthetic" | "exploratory";

export type Budget = "cheap" | "standard" | "deep";

/**
 * Orchestration patterns.
 * `plan-then-execute` is defined but not yet implemented — routes to `recursive`.
 */
export type Pattern = "direct" | "fan-out" | "chain" | "recursive" | "plan-then-execute";

export interface TaskAxes {
  decomposition: Decomposition;
  budget: Budget;
  confidence: number;
  rationale: string;
}

export interface SourceCapabilityVector {
  [sourceName: string]: {
    readonly hasList: boolean;
    readonly hasRead: boolean;
    readonly hasSearch: boolean;
    readonly hasTools: boolean;
  };
}

export interface RoutingDecision {
  /** The selected orchestration pattern. */
  pattern: Pattern;
  /** Classified task axes from the LLM classifier. */
  axes: TaskAxes;
  /** Classifier confidence (self-reported — coarse signal at v0). */
  confidence: number;
  /** One-sentence rationale from the classifier. */
  rationale: string;
  /** True when confidence was below threshold and fallback was used. */
  fallbackTriggered: boolean;
  /** What the classifier would have picked without the fallback. */
  alternativePattern?: Pattern;
  /** Wall time for the classifier call in milliseconds. */
  classifierDurationMs: number;
}

export interface RouterConfig {
  /** Whether to run the classifier. Default: true. */
  enabled: boolean;
  /**
   * Minimum classifier confidence to use the selected pattern.
   * Below this threshold, `fallbackPattern` is used instead.
   * Default: 0.6.
   */
  confidenceThreshold: number;
  /**
   * Pattern to use when confidence is below threshold or router is disabled.
   * Default: "recursive" (most general, current behavior).
   * Use "recursive" for latency-sensitive workloads.
   * Consider "plan-then-execute" (when implemented) for high-stakes workloads.
   */
  fallbackPattern: Pattern;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enabled: true,
  confidenceThreshold: 0.6,
  fallbackPattern: "recursive",
};

// ---------------------------------------------------------------------------
// Deterministic source capability derivation
// ---------------------------------------------------------------------------

/**
 * Derives a per-source capability vector from the source adapters.
 * This is the `addressability` axis — derived deterministically from what
 * the sources actually support, not inferred from task text.
 */
export function deriveSourceCapabilities(
  sources: Record<string, SourceAdapter>,
): SourceCapabilityVector {
  const caps: SourceCapabilityVector = {};
  for (const [name, adapter] of Object.entries(sources)) {
    caps[name] = {
      hasList: adapter.list != null,
      hasRead: adapter.read != null,
      hasSearch: adapter.search != null,
      hasTools: adapter.tools != null,
    };
  }
  return caps;
}

function anySourceHas(
  caps: SourceCapabilityVector,
  features: Array<keyof SourceCapabilityVector[string]>,
): boolean {
  return Object.values(caps).some((cap) => features.some((f) => cap[f]));
}

// ---------------------------------------------------------------------------
// LLM classifier — two axes only (addressability is deterministic)
// ---------------------------------------------------------------------------

const axesSchema = z.object({
  decomposition: z
    .enum(["atomic", "aggregative", "sequential", "synthetic", "exploratory"])
    .describe("How the answer composes"),
  budget: z.enum(["cheap", "standard", "deep"]).describe("How much compute to spend"),
  confidence: z.number().min(0).max(1).describe("Confidence in this classification"),
  rationale: z.string().describe("One sentence explaining the classification"),
});

const CLASSIFIER_SYSTEM_PROMPT = [
  "Classify a research task on two axes.",
  "",
  "decomposition — how does the answer compose?",
  "  atomic       — one specific fact retrievable in a single lookup",
  "  aggregative  — N independent lookups whose results are unioned",
  "  sequential   — each step depends on the previous answer (multi-hop)",
  "  synthetic    — multiple reads reasoned across jointly (summary, audit, comparison)",
  "  exploratory  — what to read is discovered during the run; scope is unknown upfront",
  "",
  "budget — how much should be spent?",
  "  cheap    — answer is in one hop; over-investment is pure waste",
  "  standard — default",
  "  deep     — correctness matters more than cost; spend tokens",
  "",
  "confidence — your confidence in this classification from 0 to 1.",
  "rationale  — one sentence explaining the classification.",
  "",
  "Consider both the task text AND the source descriptions together.",
  "A task's shape depends on what the sources can provide, not just what the task asks.",
].join("\n");

export async function classifyTask(opts: {
  task: string;
  sources: Record<string, SourceAdapter>;
  worker: LanguageModel;
}): Promise<TaskAxes> {
  const { task, sources, worker } = opts;

  const sourceDescriptions = Object.entries(sources)
    .map(([name, adapter]) => `- ${name}: ${adapter.describe()}`)
    .join("\n");

  const result = await generateText({
    model: worker,
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: ["Task:", task, "", "Available sources:", sourceDescriptions].join("\n"),
      },
    ],
    output: Output.object({ schema: axesSchema, name: "task_axes" }),
  });

  return result.output;
}

// ---------------------------------------------------------------------------
// Pattern selection — deterministic rule table
// ---------------------------------------------------------------------------

type PatternPredicate = (axes: TaskAxes, caps: SourceCapabilityVector) => boolean;

/**
 * Deterministic rule table mapping (axes, capabilities) → Pattern.
 * Rules are evaluated in order; first match wins.
 *
 * `plan-then-execute` is reserved but routes to `recursive` until implemented.
 */
const PATTERN_RULES: ReadonlyArray<[PatternPredicate, Pattern]> = [
  // atomic + cheap → direct (strip subcall tools entirely)
  [(ax) => ax.decomposition === "atomic" && ax.budget === "cheap", "direct"],

  // aggregative with searchable or listable sources → fan-out (parallel subcalls)
  [
    (ax, caps) =>
      ax.decomposition === "aggregative" && anySourceHas(caps, ["hasSearch", "hasList"]),
    "fan-out",
  ],

  // aggregative with only tool/read sources → chain (can't fan out without search/list)
  [(ax) => ax.decomposition === "aggregative", "chain"],

  // sequential → chain (each step depends on the previous)
  [(ax) => ax.decomposition === "sequential", "chain"],

  // deep budget + synthetic/exploratory → plan-then-execute (not yet implemented → recursive)
  // Uncomment when P5 is built:
  // [(ax) => ax.budget === "deep" &&
  //          (ax.decomposition === "synthetic" || ax.decomposition === "exploratory"),
  //  "plan-then-execute"],

  // default: recursive (current behavior, most general)
  [() => true, "recursive"],
];

export function selectPattern(axes: TaskAxes, caps: SourceCapabilityVector): Pattern {
  for (const [predicate, pattern] of PATTERN_RULES) {
    if (predicate(axes, caps)) {
      // plan-then-execute not yet implemented — fall through to recursive
      if (pattern === "plan-then-execute") return "recursive";
      return pattern;
    }
  }
  return "recursive";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Classifies the task and selects an orchestration pattern.
 * Returns a `RoutingDecision` that is recorded in the trace.
 */
export async function route(opts: {
  task: string;
  sources: Record<string, SourceAdapter>;
  worker: LanguageModel;
  config: RouterConfig;
}): Promise<RoutingDecision> {
  const { task, sources, worker, config } = opts;

  const startMs = Date.now();

  if (!config.enabled) {
    return {
      pattern: config.fallbackPattern,
      axes: {
        decomposition: "exploratory",
        budget: "standard",
        confidence: 1,
        rationale: "Router disabled — using fallback pattern.",
      },
      confidence: 1,
      rationale: "Router disabled.",
      fallbackTriggered: true,
      classifierDurationMs: Date.now() - startMs,
    };
  }

  const caps = deriveSourceCapabilities(sources);
  const axes = await classifyTask({ task, sources, worker });
  const classifierDurationMs = Date.now() - startMs;
  const primaryPattern = selectPattern(axes, caps);

  if (axes.confidence < config.confidenceThreshold) {
    return {
      pattern: config.fallbackPattern,
      axes,
      confidence: axes.confidence,
      rationale: axes.rationale,
      fallbackTriggered: true,
      alternativePattern: primaryPattern !== config.fallbackPattern ? primaryPattern : undefined,
      classifierDurationMs,
    };
  }

  return {
    pattern: primaryPattern,
    axes,
    confidence: axes.confidence,
    rationale: axes.rationale,
    fallbackTriggered: false,
    classifierDurationMs,
  };
}
