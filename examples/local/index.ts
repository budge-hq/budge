/**
 * Local codebase exploration example.
 *
 * Runs the @budge/core runtime against this monorepo (or any directory).
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx examples/local/index.ts "what does the auth module do"
 *   OPENAI_API_KEY=sk-... npx tsx examples/local/index.ts --verbose
 *
 * Flags:
 *   --verbose   Stream each tool call to stdout as it happens
 */

import { createRuntime, source, type ToolCallEvent } from "@budge/core";
import { anthropic } from "@ai-sdk/anthropic";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");

// The task is the first non-flag argument, or the default
const task =
  args.find((a) => !a.startsWith("-")) ??
  "Summarize the main entry point and what this codebase does";

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const runtime = createRuntime({
  model: anthropic("claude-sonnet-4-6"),
  subModel: anthropic("claude-haiku-4-5"),
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
    case "run_subcall":
      return `sub   ${event.args.source}/${event.args.path} — "${event.args.task}"`;
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

const result = await runtime.run({
  task,
  sources: {
    codebase: source.fs("/tmp/nextjs/packages/next/src", {
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
console.log(result.answer);

console.log("\n─── trace " + "─".repeat(50));
console.log(JSON.stringify(result.trace, null, 2));
