/**
 * Local codebase exploration example.
 *
 * Runs the @budge/core runtime against this monorepo (or any directory).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/local/index.ts "what does the auth module do"
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/local/index.ts --verbose
 *
 * Flags:
 *   --verbose   Stream each tool call to stdout as it happens
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createBudge, source, type ToolCallEvent } from "../../packages/core/src/index.ts";

declare const process: { argv: string[] };

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");

// The task is the first non-flag argument, or the default
const task =
  args.find((a: string) => !a.startsWith("-")) ??
  "Summarize the main entry point and what this codebase does";

// ---------------------------------------------------------------------------
// Budge
// ---------------------------------------------------------------------------

const budge = createBudge({
  orchestrator: anthropic("claude-sonnet-4-6"),
  worker: anthropic("claude-haiku-4-5"),
});

// ---------------------------------------------------------------------------
// Verbose streaming
// ---------------------------------------------------------------------------

function formatToolCall(event: ToolCallEvent): string {
  switch (event.tool) {
    case "read_source":
      return `read  ${event.args.source}/${event.args.path}`;
    case "list_source":
      return `list  ${event.args.source}${event.args.path ? `/${event.args.path}` : ""}`;
    case "search_source":
      return `search ${event.args.source} — "${event.args.query.text}" (k=${event.args.query.k})`;
    case "run_subcall":
      return `sub   ${event.args.source}/${event.args.path} — "${event.args.task}"`;
    case "run_subcalls":
      return `subs  ${event.args.calls.length} parallel sub-calls`;
    case "finish":
      return `done  (answer ready)`;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (verbose) {
  console.log(`\nTask: ${task}`);
  console.log("─".repeat(60));
}

const context = await budge.prepare({
  task,
  sources: {
    codebase: source.fs("./", {
      // Scope to source files — skip build artifacts and lockfiles
      exclude: ["node_modules", ".git", "dist", ".next", ".turbo", "coverage", ".cache"],
    }),
  },
  onToolCall: verbose
    ? (event) => {
        console.log(`  [${event.tool.padEnd(12)}] ${formatToolCall(event)}`);
      }
    : undefined,
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log("\n─── answer " + "─".repeat(49));
console.log(context.answer);

console.log("\n─── handoff " + "─".repeat(48));
console.log(context.handoff);

console.log("\n─── trace " + "─".repeat(50));
console.log(JSON.stringify(context.trace, null, 2));
