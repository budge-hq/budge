<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="./assets/wordmark-light.png"
    />
    <img
      src="./assets/wordmark-dark.png"
      alt="Budge logo"
      width="240"
    />
  </picture>
</p>

# Budge

**The context engineering runtime for AI agents.**

Most agent pipelines spend half their time figuring out what to read. Budge handles that so your agents don't have to.

Give Budge a task and your data sources. It navigates, reads, and distills everything relevant into a prepared context your agent can act on immediately — no context window management, no prompt engineering, no re-reading the same files on every turn.

## Install

```ts
pnpm add @budge/core @ai-sdk/anthropic
```

## Usage

```ts
import { createBudge, source } from "@budge/core";
import { anthropic } from "@ai-sdk/anthropic";

const budge = createBudge({
  orchestrator: anthropic("claude-sonnet-4-6"),
  worker: anthropic("claude-haiku-4-5"),
});

const context = await budge.prepare({
  task: "find all fetch calls missing error handling",
  sources: {
    codebase: source.fs("./src"),
    history: source.conversation(messages),
  },
});

context.answer; // narrative synthesis for humans
context.handoff; // compressed briefing for action agents
context.trace; // full provenance of every decision
```

## Drop it into your stack

```ts
// AI SDK chat route
const context = await budge.prepare({
  task: userMessage,
  sources: {
    codebase: source.fs("./src"),
    history: source.conversation(messages),
  },
});

return streamText({
  model: anthropic("claude-sonnet-4-6"),
  system: context.handoff,
  messages: pruneMessages({
    messages: await convertToModelMessages(messages),
    toolCalls: "before-last-2-messages",
  }),
}).toDataStreamResponse();
```

## How it works

The orchestrator receives your task and descriptions of what's available — not the data itself. It navigates sources via tool calls, reading only what it needs. When a sub-task requires deeper focus, it spawns a scoped worker call against a slice of context. The trace captures every decision. When the run completes, Budge distills everything into a handoff — a compressed briefing your action agent can consume directly.

## Sources

- `source.fs(rootPath)` — local filesystem
- `source.files(paths[])` — explicit file list
- `source.conversation(msgs[])` — message history
- `source.text(str)` — inline text blob
- `source.mcp(client, options?)` — any MCP server: databases, APIs, GitHub, Notion, and more

The source adapter interface is public. Build your own.

## Trace

`context.trace` gives you the full decomposition tree — which sources were read, tokens per call, worker calls spawned, wall time. `context.handoff` gives the action agent exactly what it needs to act without re-reading anything.

## Status

Early. API will change. Build with it anyway.

## License

MIT
