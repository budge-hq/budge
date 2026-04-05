# @polo/core

**The best context management framework for agents** — typed sources, policies, token budgets, rendering, and traces for production agent systems.

`@polo/core` is the runtime that resolves context windows: where data comes from, how it is filtered, and how it must fit under a token ceiling. At runtime, Polo returns a typed `context`, optional top-level `system` and `prompt` strings, and a detailed `trace`.

## Install

```bash
pnpm add @polo/core zod
```

`zod` is shown in examples, but any Standard Schema-compatible validator works.

## Quick Start

```ts
import { createPolo } from "@polo/core";
import { z } from "zod";

const polo = createPolo();

const taskInput = z.object({
  accountId: z.string(),
  transcript: z.string(),
});

const transcript = polo.input("transcript", { tags: ["restricted"] });

const { account } = polo.sourceSet(({ source }) => ({
  account: source.value(z.object({ accountId: z.string() }), {
    tags: ["internal"],
    async resolve({ input }) {
      return db.getAccount(input.accountId);
    },
  }),
}));

const window = polo.window({
  input: taskInput,
  id: "support_reply",
  sources: { transcript, account },
  policies: {
    require: ["transcript", "account"],
    budget: 300,
  },
  system: "You are a support engineer.",
  prompt: (context) => `Customer message:\n${context.transcript}\n\nAccount:\n${context.account}`,
});

const { context, system, prompt, trace } = await window({
  accountId: "acc_123",
  transcript: "Our webhook deliveries are timing out.",
});
```

## Core Concepts

- `polo.window({ input, sources, … })` — declare one context window; the return value is an async function you call each turn with input.
- `polo.input(key, options?)` — pass through a value from call-time input as a tagged source.
- `polo.sourceSet(({ source }) => …)` — define reusable resolver/chunk sources; use `source.value` and `source.rag` inside the builder.
- `polo.sources(...sourceSets)` — compose reusable source sets into a shared registry.
- `derive()` adds computed values to the final context.
- `policies: { require, prefer, exclude, budget }` controls inclusion, exclusions, and budgets.
- `system` and `prompt` render model-ready strings and enable exact prompt-token measurement.

## Return Value

Calling the function returned by `polo.window()` yields:

- `context`: final typed context after source resolution and policy application.
- `system`: rendered system string when configured.
- `prompt`: rendered prompt string when configured.
- `trace`: source timings, budget decisions, policy records, and prompt token metrics.

`id` is required and should be stable for the logical window definition. Polo Cloud uses it to group runs of the same window.

## Local Development

From this package directory (`packages/core`):

```bash
vp install
vp test
vp check
vp pack
```

## Example

See the working end-to-end example in
`examples/support-reply/README.md`.
