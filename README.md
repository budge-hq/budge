# Budge

**The best context framework management for agents.**

Most teams still spend most of their time on model choice, evals, and prompt tweaks. That matters, but as models improve and commoditize, more of the leverage shifts to **context**: what information you give the model, how you shape it, and how much it costs.

Budge is built for that layer.

## Why Budge

- Prevent **context rot** by making context windows explicit and repeatable.
- Prevent **context stuffing** by measuring the final prompt and enforcing budgets.
- Optimize prompts so the model sees the **highest-leverage information** for the **lowest cost**.
- Serialize structured context efficiently with **TOON** instead of bloated JSON.
- Emit exact **traces** so you can see what ran, what the prompt cost, and what the model actually received.

## How Budge Works

- Define reusable context sources once.
- Compose a context window around a specific task.
- Resolve the window into a model-ready `system`, `prompt`, and `trace`.

## Usage

### 1. Set up the runtime

```ts
import { createBudge } from "@budge/core";

export const budge = createBudge();
```

### 2. Create the context window

```ts
import { z } from "zod";

const accountSource = budge.source.value(z.object({ accountId: z.string() }), {
  async resolve({ input }) {
    return db.getAccount(input.accountId);
  },
});

const supportReply = budge.window({
  id: "support-reply",
  input: z.object({
    accountId: z.string(),
    transcript: z.string(),
  }),
  maxTokens: 4000,
  async compose({ input, use }) {
    const account = await use(accountSource, { accountId: input.accountId });

    return {
      system: `You are helping ${account.name}.`,
      prompt: `Customer message:\n${input.transcript}\n\nAccount:\n${account}`,
    };
  },
});
```

### 3. Resolve the window

```ts
const result = await supportReply.resolve({
  input: {
    accountId: "acc_123",
    transcript: "Our webhook deliveries are timing out.",
  },
});

console.log(result.system);
console.log(result.prompt);
console.log(result.trace);
```

## Primitives

- `createBudge()` sets up the runtime.
- `budge.source.value(...)` and `budge.source.rag(...)` define reusable context sources.
- `budge.window({ id, input, maxTokens, compose })` defines one context window.
- `use(source, input)` resolves context inside `compose`.
- `window.resolve({ input })` returns `system`, `prompt`, and `trace`.

## Packages

- `@budge/core` — core runtime
- `examples/support-reply` — end-to-end example of the current API

## Development

```bash
vp check
vp test
```
