[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/polo-hq/polo)

# Polo

Polo is a context assembly runtime for production AI. Define what sources a task needs, set policies for what's allowed, and get back a typed context object ready to use in your prompt.

## Installation

```
pnpm add @polo/core
```

## Usage

### Define a task

```ts
import { polo } from "@polo/core";
import { prisma } from "@/db";

const generateAINote = polo.define({
  id: "generate_ai_note",

  sources: {
    transcript: polo.input("transcript", { sensitivity: "phi" }),

    encounter: polo.source(
      async (input) =>
        prisma.encounter.findUniqueOrThrow({
          where: { id: input.encounterId },
          include: {
            patient: { include: { user: true } },
            provider: { include: { user: true, specialties: true } },
          },
        }),
      { sensitivity: "phi" },
    ),

    intake: polo.source(
      async (_input, sources) =>
        prisma.patientIntake.findFirst({
          where: { patientId: sources.encounter.patientId },
        }),
      { sensitivity: "phi" },
    ),

    priorNote: polo.source(
      async (_input, sources) =>
        prisma.providerNote.findFirst({
          where: {
            encounter: {
              patientId: sources.encounter.patientId,
              providerId: sources.encounter.providerId,
              cancelledAt: null,
              startedAt: { lt: sources.encounter.startedAt },
            },
            signedAt: { not: null },
          },
          orderBy: { encounter: { startedAt: "desc" } },
        }),
      { sensitivity: "phi" },
    ),

    noteSections: polo.source(
      async (_input, sources) => {
        const settings = await prisma.providerAiNoteSettings.findUnique({
          where: { providerId: sources.encounter.providerId },
          include: {
            noteSections: {
              where: { deletedAt: null },
              orderBy: { sortOrder: "asc" },
            },
          },
        });
        return settings?.noteSections ?? DEFAULT_AI_NOTE_SECTIONS;
      },
      { sensitivity: "internal" },
    ),
  },

  derive: ({ context }) => ({
    patientType: context.encounter.patient.isSeen ? "Follow-up" : "New",
    includeIntake: !context.priorNote,
    noteSchema: buildNoteSchema(context.noteSections),
    styleMirror: !!context.priorNote,
  }),

  policies: {
    require: ["transcript", "encounter", "noteSections"],
    prefer: ["priorNote"],
    exclude: [
      ({ context }) =>
        !context.includeIntake
          ? { source: "intake", reason: "follow-up visits exclude patient intake" }
          : false,
    ],
    budget: 12_000,
  },
});
```

### Resolve at runtime

```ts
const { context, trace } = await polo.resolve(generateAINote, {
  encounterId: "enc_123",
  transcript: "...",
});
```

### Use context in your prompt

```ts
import { generateText, Output, gateway } from "ai";

await generateText({
  model: gateway("anthropic/claude-sonnet-4.6"),
  system: buildSystemPrompt(context),
  prompt: buildPrompt(context),
  output: Output.object({ schema: context.noteSchema }),
});
```

`context` contains only what policy allowed through. Excluded sources are absent at runtime — not nulled, absent. Polo does not own the prompt. It governs the data surface you use to build it.

---

## API

|                                    |                                         |
| ---------------------------------- | --------------------------------------- |
| `polo.define(options)`             | Declare the context contract for a task |
| `polo.resolve(definition, input)`  | Resolve context at runtime              |
| `polo.input(key, options?)`        | Passthrough from call-time input        |
| `polo.source(fn, options?)`        | Single async value from any source      |
| `polo.chunks(promise, normalize?)` | Ranked multi-block source wrapper       |

---

## Sources

`polo.input()` passes through a value from call-time input. `polo.source()` wraps any async function — database queries, HTTP requests, file reads, whatever you have.

Sources can reference other resolved sources via the `sources` argument. Polo infers the dependency graph automatically and runs independent sources in parallel.

```ts
// runs immediately
encounter: polo.source(async (input) =>
  prisma.encounter.findUniqueOrThrow({ where: { id: input.encounterId } }),
);

// runs after encounter resolves
priorNote: polo.source(async (_input, sources) =>
  prisma.providerNote.findFirst({
    where: { encounter: { patientId: sources.encounter.patientId } },
  }),
);
```

## Chunks

`polo.chunks()` wraps a source that returns multiple ranked blocks. Polo fits as many as the token budget allows, drops the rest, and records each decision in the trace.

```ts
guidelines: polo.source(async (_input, sources) =>
  polo.chunks(vectorDb.search({ query: sources.transcript, topK: 10 }), (item) => ({
    content: item.pageContent,
    score: item.relevanceScore,
  })),
);
```

## Derive

`derive()` computes values from resolved sources. The result is merged onto `context` alongside source data.

```ts
derive: ({ context }) => ({
  patientType: context.encounter.patient.isSeen ? "Follow-up" : "New",
  noteSchema: buildNoteSchema(context.noteSections),
  styleMirror: !!context.priorNote,
});
```

## Policies

```ts
policies: {
  require: ["transcript", "encounter"],
  prefer:  ["priorNote"],
  exclude: [
    ({ context }) =>
      !context.includeIntake
        ? { source: "intake", reason: "follow-up visits exclude patient intake" }
        : false,
  ],
  budget: 12_000,
}
```

`require` — must resolve or `polo.resolve()` throws.  
`prefer` — included if it fits in budget.  
`exclude` — excludes a source with a reason, recorded in the trace.  
`budget` — token ceiling for the full context.

> **v0:** policies operate on top-level source keys only. If nested data needs separate treatment, promote it to its own source.

## Trace

`polo.resolve()` returns a `trace` alongside `context`. The trace records source resolution timing, sensitivity, policy decisions, chunk inclusion, and budget usage. Raw resolved values are not stored unless you opt in.

```json
{
  "sources": [
    { "key": "transcript", "type": "input", "sensitivity": "phi" },
    { "key": "encounter", "type": "single", "sensitivity": "phi", "durationMs": 12 },
    {
      "key": "priorNote",
      "type": "single",
      "sensitivity": "phi",
      "durationMs": 8
    },
    {
      "key": "recentTickets",
      "type": "chunks",
      "chunks": [
        { "included": true, "score": 0.91 },
        { "included": true, "score": 0.87 },
        { "included": false, "score": 0.42, "reason": "over_budget" }
      ]
    }
  ],
  "policies": [
    { "source": "transcript", "action": "required", "reason": "required by task" },
    {
      "source": "intake",
      "action": "excluded",
      "reason": "follow-up visits exclude patient intake"
    }
  ],
  "budget": { "max": 12000, "used": 8430 }
}
```

---

## Why Polo

Context assembly is usually handwritten glue — sources fetched manually, included unconditionally, with no token budget and no record of what the model actually saw. This works fine until outputs go wrong and you can't tell why.

Polo gives you:

- **consistent outputs** — same policies run every time, same sources, same budget
- **explicit contracts** — policies live next to source definitions, not buried in prompt templates
- **typed context** — `context` is fully typed from your source definitions, no casting
- **automatic dependency resolution** — sources run in parallel waves, no manual sequencing
- **debuggable** — when outputs go wrong, the trace tells you exactly what the model saw

---

## Fits Your Stack

- **AI SDK** — use `context` directly with `generateText`, `generateObject`, `streamText`
- **Prisma / Drizzle / any ORM** — `polo.source()` takes any async function
- **LangSmith / Braintrust** — pass `trace` to your existing observability layer

---

## License

MIT
