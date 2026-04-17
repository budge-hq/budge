import { Effect } from "effect";
import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { SourceAdapter } from "./sources/interface.ts";

// ---------------------------------------------------------------------------
// Internal types — not re-exported from index.ts
// ---------------------------------------------------------------------------

type Decomposition = "atomic" | "aggregative" | "sequential" | "synthetic" | "exploratory";

type Budget = "cheap" | "standard" | "deep";

/**
 * Orchestration patterns selected by the router.
 * `plan-then-execute` is deliberately absent — do not add speculative
 * variants; they force exhaustiveness handling in every switch.
 */
export type Pattern = "direct" | "fan-out" | "chain" | "recursive";

interface TaskAxes {
  decomposition: Decomposition;
  budget: Budget;
  confidence: number;
  rationale: string;
}

interface SourceCapability {
  hasList: boolean;
  hasRead: boolean;
  hasSearch: boolean;
  hasTools: boolean;
}

type SourceCapabilities = Record<string, SourceCapability>;

export interface RoutingDecision {
  /** The pattern that was actually selected and will run. */
  pattern: Pattern;
  /** What the classifier rule table produced, before fallback logic. */
  classifierPattern: Pattern;
  axes: TaskAxes;
  /** True when classifyTask failed; pattern is then FALLBACK_PATTERN. */
  classifierFailed: boolean;
  /** Wall time for the classifier call in milliseconds. */
  classifierDurationMs: number;
}

export interface RouteOptions {
  task: string;
  sources: Record<string, SourceAdapter>;
  worker: LanguageModel;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.6;
const FALLBACK_PATTERN: Pattern = "recursive";
const CLASSIFIER_MAX_OUTPUT_TOKENS = 200;

/**
 * Default maxSteps per pattern. Consumed by runAgent to default maxSteps
 * when the user hasn't explicitly passed one.
 */
export const MAX_STEPS_BY_PATTERN: Record<Pattern, number> = {
  direct: 5,
  "fan-out": 10,
  chain: 30,
  recursive: 100,
};

// ---------------------------------------------------------------------------
// Classifier schema
// ---------------------------------------------------------------------------

const axesSchema = z.object({
  decomposition: z
    .enum(["atomic", "aggregative", "sequential", "synthetic", "exploratory"])
    .describe("How the answer composes"),
  budget: z.enum(["cheap", "standard", "deep"]).describe("How much compute to spend"),
  confidence: z.number().min(0).max(1).describe("A number between 0 and 1 (NOT a percentage)."),
  rationale: z.string().max(200).describe("One sentence explaining the classification."),
});

const CLASSIFIER_SYSTEM_PROMPT = [
  "Classify a research task on two axes.",
  "",
  "decomposition — how does the answer compose?",
  "  atomic       — a single fact requiring ONE lookup to produce the answer.",
  "                 If answering requires reading multiple files or correlating information",
  "                 across sources, it is NOT atomic — even if the question sounds simple.",
  '                 Example: "What is the default timeout in config.ts?"',
  "  aggregative  — N independent lookups whose results are unioned.",
  "                 All sub-queries are known upfront; order does not matter.",
  '                 Example: "List every file that imports lodash."',
  "  sequential   — each step's QUERY depends on the previous step's ANSWER.",
  "                 You literally cannot formulate step N's lookup until step N-1 returns.",
  '                 Example: "Find the config for the user owned by the team that owns',
  '                 the service handling /login." You must resolve service → team → user',
  "                 → config in order because each identifier comes from the prior answer.",
  "  synthetic    — multiple reads reasoned across jointly. ALL reads are planned upfront;",
  "                 the output is a joint explanation, summary, comparison, or audit.",
  '                 Tasks asking to "trace" or "walk through" a pipeline across multiple',
  "                 components are synthetic, not sequential — you're presenting reads",
  "                 in conceptual order, but you know upfront what to read.",
  "                 sequential is reserved strictly for answer-chains where step N's",
  "                 question is unknown until step N-1 finishes.",
  '                 Example: "Trace how a request flows from entry to response."',
  "  exploratory  — what to read is discovered during the run; scope unknown upfront.",
  '                 Example: "Find and summarize any security concerns in the codebase."',
  "",
  "budget — how much should be spent?",
  "  cheap    — answer is in one hop; over-investment is pure waste",
  "  standard — default",
  "  deep     — correctness matters more than cost; spend tokens",
  "",
  "Consider BOTH the task text AND the source descriptions together.",
  "Return confidence as a number between 0 and 1 (NOT a percentage).",
  "Return a one-sentence rationale.",
].join("\n");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function deriveSourceCapabilities(sources: Record<string, SourceAdapter>): SourceCapabilities {
  const caps: SourceCapabilities = {};
  for (const [name, adapter] of Object.entries(sources)) {
    caps[name] = {
      hasList: typeof adapter.list === "function",
      hasRead: typeof adapter.read === "function",
      hasSearch: typeof adapter.search === "function",
      hasTools: typeof adapter.tools === "function",
    };
  }
  return caps;
}

function selectPattern(axes: TaskAxes, caps: SourceCapabilities): Pattern {
  const values = Object.values(caps);
  const anyFannable = values.some((c) => c.hasSearch || c.hasList || c.hasTools);

  // Rule 1: atomic → direct, regardless of budget.
  if (axes.decomposition === "atomic") return "direct";

  // Rule 2: aggregative over a fannable corpus → parallel fan-out.
  if (axes.decomposition === "aggregative" && anyFannable) return "fan-out";

  // Rule 3: aggregative over a non-fannable corpus → chain.
  if (axes.decomposition === "aggregative") return "chain";

  // Rule 4: sequential reasoning → chain.
  if (axes.decomposition === "sequential") return "chain";

  // Default: synthetic, exploratory, or anything unmatched → recursive.
  return "recursive";
}

// ---------------------------------------------------------------------------
// Classifier — Effect, may fail
// ---------------------------------------------------------------------------

function classifyTask(opts: {
  task: string;
  sources: Record<string, SourceAdapter>;
  worker: LanguageModel;
}): Effect.Effect<TaskAxes, Error> {
  const sourceBlock = Object.entries(opts.sources)
    .map(([name, adapter]) => `- ${name}: ${adapter.describe()}`)
    .join("\n");

  const user = `Task:\n${opts.task}\n\nAvailable sources:\n${sourceBlock}`;

  return Effect.tryPromise({
    try: () =>
      generateText({
        model: opts.worker,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        output: Output.object({ schema: axesSchema, name: "task_axes" }),
        maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(Effect.map((result) => result.output as TaskAxes));
}

// ---------------------------------------------------------------------------
// Main entry point — total Effect
// ---------------------------------------------------------------------------

/**
 * Classifies the task and selects an orchestration pattern.
 *
 * This Effect is TOTAL — it never fails. Classifier errors produce a
 * fallback decision with classifierFailed: true. The caller can therefore
 * wire it into the pipeline without error-channel handling.
 */
export function route(opts: RouteOptions): Effect.Effect<RoutingDecision, never> {
  return Effect.gen(function* () {
    const startMs = Date.now();
    const caps = deriveSourceCapabilities(opts.sources);

    const axesResult = yield* classifyTask({
      task: opts.task,
      sources: opts.sources,
      worker: opts.worker,
    }).pipe(Effect.either);

    const elapsed = () => Date.now() - startMs;

    if (axesResult._tag === "Left") {
      return {
        pattern: FALLBACK_PATTERN,
        classifierPattern: FALLBACK_PATTERN,
        axes: {
          decomposition: "exploratory",
          budget: "standard",
          confidence: 0,
          rationale: `classifier failed: ${axesResult.left.message}`,
        },
        classifierFailed: true,
        classifierDurationMs: elapsed(),
      } satisfies RoutingDecision;
    }

    const axes = axesResult.right;
    const classifierPattern = selectPattern(axes, caps);
    const pattern = axes.confidence < CONFIDENCE_THRESHOLD ? FALLBACK_PATTERN : classifierPattern;

    return {
      pattern,
      classifierPattern,
      axes,
      classifierFailed: false,
      classifierDurationMs: elapsed(),
    } satisfies RoutingDecision;
  });
}
