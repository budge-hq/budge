# @budge/core

`@budge/core` is the typed runtime for building and resolving context windows.

It gives you a small surface area:

- reusable context sources
- `window({ id, input, maxTokens, compose })`
- `use(source, input)` inside `compose`
- `window.resolve({ input })`
- `trace` receipts for what ran and what the prompt cost

## Install

```bash
pnpm add @budge/core zod
```

`zod` is used in the examples, but any Standard Schema-compatible validator works.

## Quick start

```ts
import { createBudge } from "@budge/core";
import { z } from "zod";

const budge = createBudge();

const noteSource = budge.source.value(z.object({ encounterId: z.string() }), {
  async resolve({ input }) {
    return db.getNote(input.encounterId);
  },
});

const window = budge.window({
  id: "scribe-note",
  input: z.object({ encounterId: z.string() }),
  maxTokens: 2000,
  async compose({ input, use }) {
    const note = await use(noteSource, { encounterId: input.encounterId });

    return {
      system: "You are an AI medical scribe.",
      prompt: `Prior note:\n${note}`,
    };
  },
});

const result = await window.resolve({
  input: { encounterId: "enc_123" },
});
```

## Runtime setup

Create one Budge runtime with `createBudge()`:

```ts
import { createBudge } from "@budge/core";

const budge = createBudge({
  onTrace(trace) {
    console.log(trace);
  },
});
```

`createBudge()` gives you:

- `budge.source.value(...)`
- `budge.source.rag(...)`
- `budge.window(...)`

## Source definitions

Sources are defined once and reused across windows.

### Value sources

Use `budge.source.value(...)` for a single resolved value:

```ts
const accountSource = budge.source.value(z.object({ accountId: z.string() }), {
  async resolve({ input }) {
    return db.getAccount(input.accountId);
  },
});
```

### RAG sources

Use `budge.source.rag(...)` for ranked multi-item context:

```ts
const docsSource = budge.source.rag(z.object({ query: z.string() }), {
  async resolve({ input }) {
    return vector.search(input.query);
  },
  normalize(item) {
    return {
      content: item.pageContent,
      score: item.score,
    };
  },
});
```

RAG sources resolve to chunk arrays when used inside `compose`.

## Context windows

The main primitive is:

```ts
budge.window({
  id,
  input,
  maxTokens,
  async compose({ input, use }) {
    // ...
    return { system, prompt };
  },
});
```

### Fields

- `id` — stable logical identifier for the window
- `input` — Standard Schema used to validate `resolve({ input })`
- `maxTokens` — prompt budget; `Infinity` disables strict enforcement
- `compose` — async function that fetches context and returns `{ system?, prompt? }`

### `compose({ input, use })`

`compose` is plain business logic.

- `input` is the validated window input
- `use(source, input)` resolves a source and returns its typed value
- regular `if` statements decide what to fetch
- the return value is the final prompt surface Budge measures

Example:

```ts
async compose({ input, use }) {
  const account = await use(accountSource, { accountId: input.accountId });

  const docs = await use(docsSource, {
    query: input.transcript,
  });

  return {
    system: `You are helping ${account.name}.`,
    prompt:
      `Customer message:\n${input.transcript}` +
      `\n\nAccount:\n${account}` +
      (docs.length ? `\n\nDocs:\n${docs}` : ""),
  };
}
```

## Rendering and TOON

Structured values interpolate directly inside strings:

```ts
prompt: `Account:\n${account}\n\nDocs:\n${docs}`;
```

Budge does not stringify these values as `[object Object]`.

Instead:

- strings pass through unchanged
- objects and arrays are serialized with **TOON**
- token counting runs on the final rendered `system` + `prompt`

This lets you write plain template strings while still getting compact structured serialization.

## Resolving a window

Resolve a window with:

```ts
const result = await window.resolve({
  input: { encounterId: "enc_123" },
});
```

`result` contains:

- `system?: string`
- `prompt?: string`
- `trace`

## Budget behavior

`maxTokens` is enforced on the final rendered prompt.

Current behavior:

- if `maxTokens === Infinity`, Budge still measures the prompt and emits `trace`
- if `maxTokens` is finite and the final rendered prompt exceeds it, Budge throws `BudgetExceededError`

This is currently a strict post-compose check. Lazy optional resolution and compaction come in later milestones.

## Errors

Current public errors:

- `BudgetExceededError` — rendered prompt exceeded `maxTokens`
- `RequiredSourceValueError` — a `use(...)` source resolved to `null` or `undefined`
- `SourceResolutionError` — a source threw while resolving

These errors can carry `trace` so you can inspect partial resolution state.

## Trace

Every successful resolve returns a `trace`.

Today it includes:

- `windowId`
- `runId`
- start/completion timestamps
- per-source timing records
- prompt token totals
- budget usage and whether it was exceeded

At a high level:

```ts
type Trace = {
  version: 1;
  runId: string;
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sources: Array<{
    sourceId: string;
    kind: "value" | "rag";
    tags: string[];
    resolvedAt: Date;
    durationMs: number;
    itemCount?: number;
  }>;
  budget: {
    max: number | null;
    used: number;
    exceeded: boolean;
  };
  prompt: {
    systemTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
};
```

## Current primitives

- `createBudge()`
- `budge.source.value(...)`
- `budge.source.rag(...)`
- `budge.window({ id, input, maxTokens, compose })`
- `use(source, input)`
- `window.resolve({ input })`

## Example

See `examples/support-reply` for a full working example of the current API.

## Local development

```bash
vp test
vp check
vp pack
```
