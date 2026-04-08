# @budge/core

`@budge/core` is the typed runtime for declaring context windows, resolving source graphs, and returning `context` plus `traces`.

It does not compose prompts, wrap model clients, or score model outputs.

## Install

```bash
pnpm add @budge/core zod
```

`zod` is used in the examples, but any Standard Schema-compatible validator works.

## Quick Start

```ts
import { createBudge } from "@budge/core";
import { z } from "zod";

const budge = createBudge();

const patientSource = budge.source.value(z.object({ patientId: z.string() }), {
  async resolve({ input }) {
    return db.getPatient(input.patientId);
  },
});

const priorNoteSource = budge.source.value(
  z.object({}),
  { patient: patientSource },
  {
    async resolve({ patient }) {
      return db.getPriorNote(patient.id);
    },
  },
);

const window = budge.window({
  id: "note-generation",
  input: z.object({
    patientId: z.string(),
    transcript: z.string(),
  }),
  sources: ({ source }) => ({
    transcript: source.fromInput("transcript"),
    patient: patientSource,
    priorNote: priorNoteSource,
  }),
});

const { context, traces } = await window.resolve({
  input: {
    patientId: "pat_123",
    transcript: "Patient reports less pain this week.",
  },
});

const prompt = {
  system: "You are a clinical documentation assistant.",
  prompt:
    `Transcript:\n${context.transcript}` +
    `\n\nPatient:\n${JSON.stringify(context.patient, null, 2)}` +
    `\n\nPrior note:\n${context.priorNote}`,
};
```

## Runtime Setup

Create one runtime with `createBudge()`:

```ts
const budge = createBudge({
  onTrace(traces) {
    console.log(traces);
  },
});
```

`createBudge()` exposes:

- `budge.source.value(...)`
- `budge.source.rag(...)`
- `budge.source.history(...)`
- `budge.source.fromInput(...)`
- `budge.window(...)`

## Source APIs

Sources are declared once and selected into a window.

### `source.value(input, config)`

Use `value` for a single resolved value:

```ts
const accountSource = budge.source.value(z.object({ accountId: z.string() }), {
  async resolve({ input }) {
    return db.getAccount(input.accountId);
  },
});
```

### `source.value(input, deps, config)`

Use the dependency overload when a source depends on another source handle:

```ts
const billingNotesSource = budge.source.value(
  z.object({}),
  { account: accountSource },
  {
    async resolve({ account }) {
      return db.getBillingNotes(account.id);
    },
  },
);
```

Dependencies are inferred from the handles you pass into `deps`. Budge builds the DAG from those handles and resolves sources in waves.

### `source.rag(input, config)`

Use `rag` for ranked multi-item context:

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

RAG sources resolve to `Chunk[]`.

### `source.history(input, config)`

Use `history` for framework-agnostic message arrays that should be filtered and compacted before they enter `context`:

```ts
const historySource = budge.source.history(z.object({ threadId: z.string() }), {
  async resolve({ input }) {
    return db.getMessages(input.threadId);
  },
  filter: {
    excludeKinds: ["tool_call", "reasoning"],
  },
  compaction: {
    strategy: "sliding",
    maxMessages: 12,
  },
});
```

History sources resolve to `Message[]`. In v0, compaction is count-based and only supports a sliding window.

### `source.rag(input, deps, config)`

`rag` also supports dependency-aware overloads:

```ts
const recentTicketsSource = budge.source.rag(
  z.object({ transcript: z.string() }),
  { account: accountSource },
  {
    async resolve({ input, account }) {
      return vector.searchTickets(account.id, input.transcript);
    },
    normalize(item) {
      return {
        content: item.pageContent,
        score: item.relevanceScore,
      };
    },
  },
);
```

### `source.fromInput(key, options?)`

Use `fromInput` when a validated field should flow directly into `context`:

```ts
const window = budge.window({
  id: "support-reply",
  input: z.object({ transcript: z.string() }),
  sources: ({ source }) => ({
    transcript: source.fromInput("transcript", { tags: ["restricted"] }),
  }),
});
```

## Window API

The main primitive is:

```ts
budge.window({
  id,
  input,
  sources: ({ source }) => ({
    // ...
  }),
});
```

### Fields

- `id` - stable logical identifier for the window
- `input` - Standard Schema used to validate `resolve({ input })`
- `sources` - builder that returns the source graph for the window

The builder is declarative. It describes which sources can appear in `context`, and Budge precomputes the dependency graph when the window is created.

## Resolution

Resolve a window with:

```ts
const result = await window.resolve({
  input: {
    patientId: "pat_123",
    transcript: "Patient reports less pain this week.",
  },
});
```

`result` contains:

- `context`
- `traces`

You own prompt assembly from there:

```ts
const prompt = {
  system: "You are a helpful assistant.",
  prompt: JSON.stringify(result.context, null, 2),
};
```

## Return Shape

At a high level:

```ts
type ResolveResult<TContext> = {
  context: TContext;
  traces: Trace;
};
```

## Errors

Current public errors:

- `CircularSourceDependencyError` - the window source graph contains a cycle
- `MissingSourceDependencyError` - a selected source depends on an unselected source
- `SourceResolutionError` - a source threw while resolving

Errors can carry `traces` so you can inspect partial resolution state.

## Trace Shape

Every successful resolve returns a `traces` object.

```ts
type Trace = {
  version: 1;
  runId: string;
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sources: Array<{
    key: string;
    sourceId: string;
    kind: "input" | "value" | "rag" | "history";
    tags: string[];
    dependsOn: string[];
    completedAt: Date;
    durationMs: number;
    status: "resolved" | "failed";
    itemCount?: number;
    totalMessages?: number;
    includedMessages?: number;
    droppedMessages?: number;
    droppedByKind?: Record<string, number>;
    strategy?: "sliding";
    maxMessages?: number;
  }>;
};
```

## Current Scope

What `@budge/core` does today:

- declarative source selection
- dependency-graph planning
- wave-based source resolution
- type-safe `context`
- source-level traces
- history filtering and sliding compaction

What `@budge/core` does not do today:

- prompt composition
- model wrapping
- output scoring
- tools API
- semantic or llm history compaction
- budget management

## Example

See `examples/support-reply` for a full working example of the current API.

## Local Development

```bash
vp test
vp check
vp pack
```
