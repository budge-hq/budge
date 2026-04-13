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

The agent runtime that navigates your data.

Most agent frameworks make you manage the context window. Budge gives that job to the model.
Your agent navigates context like a librarian, not a reader. The model decides what to read and when. You never touch a context window.

## Install

```ts
pnpm add @budge/core @ai-sdk/anthropic
```

## Usage

```ts
import { createRuntime, source } from "@budge/core";
import { anthropic } from "@ai-sdk/anthropic";

const runtime = createRuntime({
  model: anthropic("claude-sonnet-4-6"),
  subModel: anthropic("claude-haiku-4-5"),
});

const result = await runtime.run({
  task: "what does the auth module do and how could it be improved",
  sources: {
    codebase: source.fs("./src"),
    docs: source.files(["./README.md"]),
  },
});

console.log(result.answer);
console.log(result.trace);
```

## How it works

The root agent receives your task and descriptions of what's
available — not the data itself. It navigates sources via tool
calls, reading only what it needs. When a sub-task requires deeper
focus, it spawns a scoped sub-call against a slice of context using
the cheaper subModel. The trace captures every decision.

## Sources

source.fs(rootPath) — local filesystem
source.files(paths[]) — explicit file list  
source.conversation(msgs[]) — message history

The source adapter interface is public. Build your own.

## Trace

result.trace gives you the full decomposition tree — which sources
were read, tokens per call, sub-calls spawned, wall time.

## Status

Early. API will change. Build with it anyway.

## License

MIT
