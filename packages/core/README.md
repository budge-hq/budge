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
    notes: source.text("Deployment notes: auth uses JWT, 24h expiry."),
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
- `trace`: full record of searches, reads, listings, sub-calls, and timing

## Sources

### Built-in factories

**`source.fs(rootPath, options?)`** — local filesystem directory. Supports list, read, and ripgrep-powered search (WASM, no install required).

```ts
source.fs("./src");
source.fs("./src", { include: [".ts", ".tsx"], excludePatterns: ["generated"] });
```

**`source.text(content, options?)`** — inline string. Auto-chunks above ~4000 tokens, enabling list, read, and BM25 search. Below the threshold, exposes read only.

```ts
source.text(visitTranscript);
source.text(encounterNote, { chunk: { strategy: "paragraphs" } });
```

**`source.json(value, options?)`** — JSON-serializable value. Serializes with `safe-stable-stringify` (handles circular references), then behaves identically to `source.text`. The auto-generated `describe()` lists the top-level keys.

```ts
source.json(patientRecord);
// describe() → "JSON object with keys: id, first_name, last_name, dob, medications, allergies (~492 tokens)."
```

### Plain objects for everything else

Any object satisfying `SourceAdapter` works. Only `describe()` is required — implement whichever of `list`, `read`, `search`, and `tools` match your data source.

**Search source** (e.g. a vector store):

```ts
const precedent: SourceAdapter = {
  describe: () => `Historical encounter notes. Searchable by semantic similarity.
    Filters: patient_id, note_type, date_range, specialty.`,
  search: async (query) => myVectorSearch(query),
  read: async (id) => fetchById(id), // optional — enables run_subcall by ID
};
```

**Database with tools**:

```ts
const db: SourceAdapter = {
  describe: () => "Patient database. Use the provided tools to search and look up records.",
  tools: () => ({
    search_patients: tool({
      description: "Search patients by name or DOB.",
      inputSchema: z.object({ name: z.string().optional(), birth_year: z.number().optional() }),
      execute: async (params) => searchPatients(pool, params),
    }),
    get_patient: tool({
      description: "Get full demographics for a patient by ID.",
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => getPatient(pool, id),
    }),
  }),
};
```

**MCP server** (via AI SDK's `createMCPClient`):

```ts
import { createMCPClient } from "@ai-sdk/mcp";

const mcpClient = await createMCPClient({
  transport: { type: "sse", url: "https://mcp.example.com/sse" },
});

const externalService: SourceAdapter = {
  describe: () => "External service via MCP.",
  tools: async () => mcpClient.tools(),
};
```

**Static key-value data**:

```ts
const patient: SourceAdapter = {
  describe: () => "Current patient demographics and clinical summary.",
  read: async () => JSON.stringify(patientData, null, 2),
};
```

### `SourceAdapter` interface

```ts
interface SourceAdapter {
  describe(): string; // required
  list?(path?: string): Promise<string[]>; // optional
  read?(path: string): Promise<string>; // optional
  search?(query: SearchQuery): Promise<SearchMatch[]>; // optional
  tools?(): Record<string, Tool>; // optional
}
```

Each method is optional. The orchestrator receives tools derived from whichever methods you implement — `list_source` and `read_source` only appear when at least one source supports them, `search_source` only when at least one source supports search, and source-contributed tools are namespaced as `sourceName.toolName`.

## Trace

`prepared.trace` records:

- which paths were read from each source
- every root tool call and its result (reads, lists, searches, sub-calls)
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
