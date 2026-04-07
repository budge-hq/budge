# Budge

> The missing observability layer for context assembly. Evals for inputs, not outputs.

## The problem

Every AI eval tool measures what comes out of the model.

- Braintrust
- LangSmith
- Promptfoo

That is useful, but it leaves a blind spot before the model call.

Developers are stuffing transcripts, retrieved chunks, documents, tool definitions, and history into a context window with no principled way to answer:

- what got included
- why it got included
- what depended on what
- which input changed the outcome

When a score moves, they see the output. They do not see the assembly decisions that caused it.

## Where Budge Lives

```text
[your data sources] -> budge -> [model call] -> [braintrust / langsmith]
transcripts, docs,    assembly    your prompt,    output scoring
rag, tools, history   + tracing   your model
```

Budge is not a model wrapper.

It does not own your prompt, your model client, or your output scoring. It starts where your data sources are and ends where the model call begins.

That makes it complementary to every eval tool that already exists.

## Why Budge

Output evals tell you whether something got better or worse.

Budge tells you what changed in the inputs.

- Which sources were present for this run?
- Which sources depended on other sources?
- Which retrieved chunks actually made it in?
- Which assembly decisions changed across runs?

The missing layer is not another prompt playground. It is observability for context assembly.

## What Budge Owns

Today in OSS:

- declarative source assembly
- typed sources as the unit of abstraction
- dependency-graph resolution in waves
- traces for every assembly decision

Directionally in Budge Cloud:

- compaction policies
- budget management configured at runtime
- semantic selection for tools and retrieved context
- input attribution across runs

The core idea stays the same: Budge owns what goes into context, not what comes out of the model.

## The Causal Engine

Every source inclusion is a treatment. Every eval score is a response variable.

That is the wedge.

Braintrust can tell you a score moved. Budge can tell you which input decisions plausibly caused it to move.

- Was it the prior note?
- The intake?
- The fourth retrieved chunk?
- The tool manifest?

That feedback loop does not exist in the current tooling stack.

## vs Existing Tools

|                   | Braintrust / LangSmith / prompt evals | Budge                         |
| ----------------- | ------------------------------------- | ----------------------------- |
| Where it sits     | After the model call                  | Before the model call         |
| What it measures  | Output quality                        | Input assembly                |
| What it tells you | Prompt A beat prompt B                | Which sources changed the run |
| What you can do   | Tweak prompts and model settings      | Change what goes into context |

## Current SDK

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
    };
  },
});

const { context, traces } = await noteGeneration.resolve({
  input: {
    patientId: "pat_123",
    transcript: "Patient reports less pain this week.",
  },
});

// Developer owns the prompt from here.
```

The current open-source SDK is intentionally narrow:

- no prompt composition
- no model wrapping
- no output scoring
- no YAML or DSL

## Roadmap

Phase 1: open-source SDK

- TypeScript-first
- framework agnostic
- works wherever a model call happens
- optimized for design partners with production agent loops

Phase 2: Budge Cloud

- trace ingestion
- causal attribution
- runtime budget and compaction tuning from the dashboard
- cross-customer signal

## SDK Principles

1. Every primitive that could live on the window lives on the window.
2. Budge ends where the model call begins.
3. Sources are the unit of abstraction.
4. Tracing is not optional.
5. The developer owns the prompt.
6. TypeScript-first, no YAML, no DSL.
7. Budget belongs to runtime configuration, not prompt glue code.
8. Compaction is an assembly policy, not a memory system.
9. Filters run before compaction.
10. Framework agnostic by default.
11. Semantic selection beats manual curation.
12. Integration burden must stay lower than the insight value.
13. Optimizations are recommendations, not hidden defaults.
14. Configuration should move at runtime, not only deploy time.
15. Sources are declarative and the dependency graph is explicit.

## Packages

- `@budge/core` - current OSS SDK
- `examples/support-reply` - end-to-end example

## Development

```bash
vp check
vp test
```
