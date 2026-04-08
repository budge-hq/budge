# @budge/core

Typed runtime for declaring context windows, resolving source graphs, and returning `context` plus `traces`.

Does not compose prompts, wrap model clients, or score outputs.

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

// You own the prompt from here.
// context is typed — context.patient, context.priorNote, context.transcript
// traces carries per-source timing, token estimates, and assembly details
```

---

## Runtime setup

```ts
const budge = createBudge({
  // Called after every resolve with the full trace.
  onTrace(trace) {
    console.log(trace);
  },

  // Optional. tokenx is used by default (~96% accuracy).
  // Replace with tiktoken or any tokenizer that exposes estimate(text: string): number.
  tokenizer: {
    estimate: myTokenizer.countTokens,
  },
});
```

`createBudge()` returns a `BudgeInstance` with:

- `budge.source.value(...)`
- `budge.source.rag(...)`
- `budge.source.history(...)`
- `budge.source.tools(...)`
- `budge.source.fromInput(...)`
- `budge.window(...)`

---

## Source APIs

Sources are declared once and composed into windows. They are resolved in dependency order, in parallel where possible.

### `source.value(input, config)`

Resolves a single typed value.

```ts
const accountSource = budge.source.value(z.object({ accountId: z.string() }), {
  async resolve({ input }) {
    return db.getAccount(input.accountId);
  },
});
```

### `source.value(input, deps, config)`

Use the dependency overload when a source needs the resolved value of another source.

```ts
const billingSource = budge.source.value(
  z.object({}),
  { account: accountSource },
  {
    async resolve({ account }) {
      return db.getBillingNotes(account.id);
    },
  },
);
```

Budge infers the dependency graph from the handles you pass into `deps` and resolves sources in parallel waves.

### `source.rag(input, config)`

Resolves a ranked `Chunk[]` from a retrieval pipeline.

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

`normalize` maps your retrieval result shape to `{ content: string; score?: number; metadata?: Record<string, unknown> }`. If your retrieval already returns `Chunk[]`, you can omit it.

`rag` also accepts a `deps` overload identical to `source.value`.

### `source.history(input, config)`

Resolves `Message[]` with optional filtering and sliding window compaction.

```ts
const historySource = budge.source.history(z.object({ threadId: z.string() }), {
  async resolve({ input }) {
    return db.getMessages(input.threadId);
  },
  filter: {
    // Strip messages by kind before compaction runs.
    excludeKinds: ["tool_call", "reasoning"],
  },
  compaction: {
    strategy: "sliding",
    maxMessages: 12, // Keep the last 12 messages after filtering.
  },
});
```

If `compaction` is omitted, a default sliding window of 20 messages is applied. The applied window is always recorded in the trace.

**Message type:**

```ts
interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  kind?: "text" | "tool_call" | "tool_result" | "reasoning";
  createdAt?: Date;
}
```

`kind` defaults to `"text"` for most messages. Messages with `role: "tool"` are inferred as `"tool_result"` if `kind` is absent.

### `source.tools(config)`

Resolves a `Record<string, ToolDefinition>` from static definitions, MCP clients, or both.

```ts
const toolsSource = budge.source.tools({
  // Static inline tools.
  tools: {
    searchDocs: {
      description: "Search the knowledge base",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  },

  // One or more MCP clients. Transport-agnostic — local stdio and remote HTTP/SSE
  // clients both work as long as they expose a tools() method.
  mcp: mcpClient, // or [clientA, clientB]
});
```

MCP tools win on name collision with static tools. Last MCP client wins on collision between MCP clients. All collisions are recorded in the trace.

If a tool omits `inputSchema`, it defaults to `{}` (any input). Budge is permissive about upstream tool quality.

**Custom normalization:**

```ts
source.tools({
  mcp: client,
  normalize(name, raw) {
    return {
      name: name.replace(/_/g, "-"),
      description: raw.description as string | undefined,
      inputSchema: (raw.inputSchema ?? {}) as Record<string, unknown>,
    };
  },
});
```

When `normalize` is provided, the final record is keyed by `ToolDefinition.name` as returned by the normalize function.

**Context shape:**

```ts
context.tools; // Record<string, ToolDefinition>

// Pass directly to your model call:
await generateText({ model, tools: context.tools, prompt });
```

### `source.fromInput(key, options?)`

Passes a validated field from window input directly into context with no resolver.

```ts
sources: ({ source }) => ({
  transcript: source.fromInput("transcript", { tags: ["restricted"] }),
});
```

---

## Window API

```ts
budge.window({
  id: string, // Stable identifier — used in traces and cloud config.
  input: Schema, // Standard Schema (zod, valibot, etc.) for resolve() input.
  sources: (helpers) => Record<string, AnySource>,
});
```

The `sources` builder is declarative. Budge precomputes the dependency graph when the window is created. Calling `resolve()` runs the graph.

### `window.resolve(payload)`

```ts
const { context, traces } = await window.resolve({ input });
```

`context` is fully typed based on your source declarations. `traces` carries the full assembly record for this run.

---

## Traces

Every `resolve` returns a `Trace` alongside `context`.

```ts
interface Trace {
  version: 1;
  runId: string;
  windowId: string;
  startedAt: Date;
  completedAt: Date;
  sources: SourceTrace[];
}
```

### SourceTrace

All sources:

```ts
{
  key: string;
  sourceId: string;
  kind: "input" | "value" | "rag" | "history" | "tools";
  tags: string[];
  dependsOn: string[];
  completedAt: Date;
  durationMs: number;
  status: "resolved" | "failed";
  contentLength?: number;      // Character count of serialized content.
  estimatedTokens?: number;    // tokenx estimate by default. Absent if serialization fails.
}
```

Additional fields for `kind: "rag"`:

```ts
{
  itemCount?: number;          // Number of chunks returned.
}
```

Additional fields for `kind: "history"`:

```ts
{
  totalMessages?: number;           // Messages returned by resolve().
  includedMessages?: number;        // Messages after filter + compaction.
  droppedMessages?: number;         // totalMessages - includedMessages.
  droppedByKind?: Record<string, number>; // Filter drops broken down by kind.
  compactionDroppedMessages?: number;     // Drops from sliding window only.
  strategy?: "sliding";
  maxMessages?: number;
}
```

Additional fields for `kind: "tools"`:

```ts
{
  totalTools?: number;              // Raw tool count before merge.
  includedTools?: number;           // Tools in context after merge.
  droppedTools?: number;            // Overwrites from name collisions.
  toolNames?: string[];             // Names of included tools.
  toolSources?: {
    static: string[];               // Tools from config.tools.
    mcp: string[];                  // Tools from MCP clients.
  };
  toolCollisions?: Array<{
    name: string;
    winner: "static" | "mcp";
    loser: "static" | "mcp";
  }>;
}
```

---

## Errors

```ts
CircularSourceDependencyError; // Source graph contains a cycle.
MissingSourceDependencyError; // A source depends on an unselected source.
SourceResolutionError; // A source threw during resolution.
```

All errors carry `traces` so you can inspect the partial resolution state at the point of failure.

---

## Token estimation

`@budge/core` ships with [tokenx](https://github.com/johannschopplich/tokenx) as the default tokenizer (~96% accuracy, 2kB, no native dependencies). `estimatedTokens` is populated on every source trace automatically.

To use a more precise tokenizer:

```ts
import { encode } from "gpt-tokenizer";

const budge = createBudge({
  tokenizer: {
    estimate: (text) => encode(text).length,
  },
});
```

Tokenizer failures are always silent — `estimatedTokens` will be absent but context assembly continues normally. `contentLength` (character count) is always populated when serialization succeeds, regardless of tokenizer.

---

## Examples

See `examples/support-reply` for a full working example combining value, rag, history, and tools sources.

---

## Local development

```bash
pnpm test
pnpm check
pnpm pack
```
