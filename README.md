<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="./assets/budge-logo-dark.png"
    />
    <img
      src="./assets/budge-logo.png"
      alt="Budge logo"
      width="240"
    />
  </picture>
</p>

# Budge

**The context intelligence layer for AI agents.** Budge is a typed framework for assembling model context windows. It resolves your sources, builds the dependency graph, and returns traces alongside every result — so you always know exactly what went into the model and why.

---

## The problem

We analyzed 8,257 real agent sessions across three independent sources. The findings are consistent:

- At the median turn, **99.8% of what the model sees is content it already read**
- Context grows **6x** from session start to end and never comes back down
- When compaction fires, summaries are **87.9% as large as what they replaced** — and context returns to baseline in 96 turns
- Across 7,003 benchmark sessions and 22 frontier models, **zero agents ever invoked the context management tools** available to them

The problem is not that context windows are too small. It is that nobody knows what is in them.

Budge covers the input side.

---

## Where Budge sits

```
[your data sources] → budge → [model call] → [your eval tool]
 transcripts, docs,   assembly   your prompt,   output scoring
 rag, tools, history  + tracing  your model
```

Budge starts where your data sources are and ends where the model call begins. It does not wrap the model, touch your prompt, or score outputs. That boundary is intentional. It makes Budge composable with every framework and eval tool you already use.

---

## What it does

You declare a context window as a graph of typed sources. Budge resolves them in dependency order, assembles the context, and returns traces alongside every result.

```ts
import { createBudge } from "@budge/core";
import { z } from "zod";

const budge = createBudge({
  sessionId: "ses_abc123",
  onTrace(trace) {
    // ship to Budge cloud or your own backend
    fetch("https://your-ingestor/traces", {
      method: "POST",
      body: JSON.stringify(trace),
    });
  },
});

const noteGeneration = budge.window({
  id: "note-generation",
  input: z.object({
    patientId: z.string(),
    transcript: z.string(),
  }),
  sources: ({ source }) => {
    const patient = source.value(z.object({ patientId: z.string() }), {
      async resolve({ input }) {
        return getPatient(input.patientId);
      },
    });

    const priorNote = source.value(
      z.object({}),
      { patient },
      {
        async resolve({ patient }) {
          return getPriorNote(patient.id);
        },
      },
    );

    return {
      transcript: source.fromInput("transcript"),
      patient,
      priorNote,
      history: source.history(z.object({ patientId: z.string() }), {
        async resolve({ input }) {
          return getMessages(input.patientId);
        },
        filter: { excludeKinds: ["tool_call", "reasoning"] },
        compaction: { strategy: "sliding", maxMessages: 12 },
      }),
      tools: source.tools({
        mcp: mcpClient,
      }),
    };
  },
});

const { context, traces } = await noteGeneration.resolve({
  input: { patientId: "pat_123", transcript: "Patient reports less pain." },
  sessionId: "ses_abc123",
  turnIndex: 4,
});

// You own the prompt from here.
// traces tells you exactly what was assembled and how long it took.
```

Every `resolve` returns `traces` alongside `context`:

```ts
traces.runId;       // unique identifier for this resolve
traces.sessionId;   // groups resolves into a session
traces.turnIndex;   // position in the session sequence — required for replay

traces.sources;     // per-source:
                    //   key, kind, status, durationMs
                    //   estimatedTokens, contentLength, contentHash
                    //   fingerprint — stable "${windowId}:${key}" identifier
                    //
                    // history: totalMessages, includedMessages,
                    //          droppedMessages, droppedByKind
                    // tools:   totalTools, includedTools,
                    //          toolNames, toolCollisions
```

---

## Source kinds

| Kind                 | What it does                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ |
| `source.value()`     | Resolves a single typed value. Supports dependencies on other sources.               |
| `source.rag()`       | Resolves a ranked `Chunk[]` from a vector search or retrieval pipeline.              |
| `source.history()`   | Resolves `Message[]` with filtering by kind and sliding window compaction.           |
| `source.tools()`     | Resolves a `Record<string, ToolDefinition>` from static definitions and MCP clients. |
| `source.fromInput()` | Passes a validated field from window input directly into context.                    |

Sources declared outside a window are reusable across windows. Budge builds the dependency graph at window creation time and resolves sources in parallel waves.

---

## What Budge does not do

- Compose prompts
- Wrap model clients
- Score outputs
- Own storage or persistence
- Require a specific framework

The boundary is the model call. Budge hands you `context` and `traces`. What you do with context is yours.

---

## Packages

| Package                  | Description                                                           |
| ------------------------ | --------------------------------------------------------------------- |
| `@budge/core`            | The core SDK — source assembly, tracing, and typed context resolution |
| `examples/support-reply` | End-to-end example using value, rag, history, and tools sources       |

---

## Budge Spring

The open-source SDK is the instrumentation layer. Budge is where the data becomes useful:

- **Session viewer** — see exactly what went into every turn, by source, with token attribution
- **Waste classification** — automatic detection of stale reads, duplicate payloads, and superseded sources
- **Shadow policy** — estimate savings before touching runtime behavior; distinguish raw token reduction from actual cost reduction with cache awareness
- **Autopilot** — deterministic eviction of exact duplicates and stale reads, with full audit log and one-click rollback
- **Replay and counterfactuals** — re-run historical sessions against updated assembly logic without re-fetching live data

The SDK works standalone.

---

## Development

```bash
pnpm install
pnpm check
pnpm test
```
