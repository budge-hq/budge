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

**The context assembly layer for AI agents.** Budge is a typed framework for assembling model context windows. It resolves your sources, builds the dependency graph, and returns traces alongside every result.

---

## The problem

Eval tools measure what comes out of the model. Nothing measures what goes in.
Braintrust and LangSmith start at the model call. Everything before it is invisible to them: which sources you included, which history you compacted, which tools you loaded. When a score moves you see the output that changed, not the assembly decisions that caused it.
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

const budge = createBudge();

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
});

// You own the prompt from here.
// traces tells you exactly what was assembled and how long it took.
```

Every `resolve` returns `traces` alongside `context`:

```ts
traces.sources; // per-source: kind, status, durationMs, estimatedTokens, contentLength
// history: totalMessages, includedMessages, droppedMessages, droppedByKind
// tools: totalTools, includedTools, toolNames, toolCollisions
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

## Budge Cloud

The open-source SDK is the instrumentation layer. Budge Cloud is where the data becomes useful:

- **input attribution across runs** which sources drove better outcomes, not just which runs scored higher
- **causal analysis** treat source inclusions as experiments and measure their effect on output quality
- **runtime budget** and **compaction tuning** from the dashboard, no redeploy required
- **semantic tool selection** load only the tools relevant to the current task

The SDK works standalone. Cloud is opt-in.

---

## Development

```bash
pnpm install
pnpm check
pnpm test
```
