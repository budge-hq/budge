# @budge/core

`@budge/core` prepares context for an action agent.

Budge explores your sources lazily, returns a human-readable answer, synthesizes an action-agent-ready handoff, and preserves a full trace of what it accessed.

## Install

```bash
vp add @budge/core @ai-sdk/anthropic
```

## Quick Start

```ts
import { createBudge, source } from "@budge/core";
import { anthropic } from "@ai-sdk/anthropic";

const budge = createBudge({
  orchestrator: anthropic("claude-sonnet-4-6"),
  worker: anthropic("claude-haiku-4-5"),
});

const context = await budge.prepare({
  task: "What does the auth module do, and what are the main risks?",
  sources: {
    codebase: source.fs("./src"),
    docs: source.files(["./docs/auth.md"]),
    history: source.conversation(messages),
  },
});

console.log(context.answer);
console.log(context.handoff);
console.log(context.trace);
```

## Two Phases

Use Budge as the preparation phase, then hand the briefing to your action agent.

```ts
import { streamText } from "ai";

const prepared = await budge.prepare({
  task: "Review the auth module and propose a fix plan.",
  sources: {
    codebase: source.fs("./src"),
    docs: source.files(["./docs/auth.md"]),
  },
});

return streamText({
  model: anthropic("claude-sonnet-4-6"),
  system: [
    "You are the implementation agent.",
    "Use the prepared context below before taking action.",
    prepared.handoff,
  ].join("\n\n"),
  messages,
});
```

Budge prepares context. Your agent acts on it.

## API

### `createBudge(options)`

```ts
const budge = createBudge({
  orchestrator,
  worker,
  concurrency: 5,
});
```

- `orchestrator`: primary model for the root agent loop
- `worker`: model used for focused sub-calls and handoff generation
- `concurrency`: max in-flight worker calls inside `run_subcalls` (default `5`)

### `budge.prepare(options)`

```ts
const prepared = await budge.prepare({
  task: "Summarize the auth module",
  sources: {
    codebase: source.fs("./src"),
  },
  maxSteps: 100,
  onToolCall(event) {
    console.log(event.tool, event.args);
  },
});
```

- `task`: research task for Budge to complete
- `sources`: named source adapters Budge can navigate
- `onToolCall`: optional callback for progress streaming
- `subcallSchemas`: optional named schemas for structured sub-call output
- `maxSteps`: optional safety cap for the root loop

### `PreparedContext`

```ts
interface PreparedContext<S> {
  task: string;
  answer: string;
  handoff: string;
  finishReason: "finish" | "max_steps" | "no_finish";
  trace: RuntimeTrace<S>;
}
```

- `answer`: Budge's human-readable research answer
- `handoff`: briefing document for the next agent
- `trace`: full record of reads, listings, sub-calls, and timing

## Source Adapters

- `source.fs(rootPath, options?)`
- `source.files(paths)`
- `source.conversation(messages)`
- `source.text(value)`
- `source.mcp(client, options?)`

Implement `SourceAdapter` to bring your own source type.

## Trace

`prepared.trace` records:

- which paths were read from each source
- every root tool call and its result
- all focused worker sub-calls
- token usage and duration

Use the trace for debugging, observability, and audit trails.

## Structured Sub-Calls

Register named schemas and reference them from `run_subcall` or `run_subcalls`.

```ts
import { z } from "zod";

const prepared = await budge.prepare({
  task: "Audit fetch handling",
  sources: {
    codebase: source.fs("./src"),
  },
  subcallSchemas: {
    audit: z.object({
      verdict: z.enum(["missing", "present"]),
      context: z.string(),
    }),
  },
});
```

## Local Development

```bash
vp test
vp check
vp pack
```
