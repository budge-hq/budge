# Polo

**Better context. Better outputs.**

Most AI output problems are context problems.

Too much irrelevant data. Stale sources mixed with fresh ones. No token budget. Sensitive fields that should never have been included. Logic for deciding what to include scattered across the codebase with no way to explain what happened later.

[Anthropic's engineering team put it directly](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): *"Good context engineering means finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."* Not the most tokens. The right tokens.

[Cursor found the same thing in production](https://cursor.com/blog/dynamic-context-discovery): dynamic context discovery reduced total agent tokens by **46.9%** in MCP-tool runs, and they argue it can improve response quality by reducing confusing or contradictory information in the context window.

The industry has a name for this now: **context engineering**. And it turns out the hard part is not retrieval. It is deciding, for a specific task, what context belongs in the call at all.

That logic usually lives as prompt glue scattered through application code. Polo turns it into an explicit contract.

---

Most AI apps still build context like this:

```ts
const prompt = `
Transcript:
${transcript}

Customer account:
${accountSummary}

Recent tickets:
${recentTickets.slice(0, 5).join("\n\n")}

Write a support reply.
`;
```

It works until it doesn't.

As your AI features grow, this approach breaks down:

- more data sources mean more decisions buried in string templates
- stale data mixed with fresh data degrades output quality
- no token budget means inconsistent results as context balloons
- sensitive fields get included accidentally
- when outputs go wrong, you cannot answer the most important debugging question: what was the model allowed to see?

---

With Polo:

```ts
import { generateText, gateway } from "ai";
import { polo } from "@polo/core";

const model = gateway("anthropic/claude-sonnet-4.6");

const supportReply = polo.define({
  id: "support_reply",

  sources: {
    transcript: polo.input("transcript", { sensitivity: "restricted" }),
    account: polo.source(
      async (input) =>
        db.account.findUniqueOrThrow({ where: { id: input.accountId } }),
      { sensitivity: "internal" },
    ),
    recentTickets: polo.source(
      async (input) =>
        polo.chunks(
          vectorDb.search({ query: input.transcript, topK: 10 }),
          (item) => ({ content: item.pageContent, score: item.relevanceScore }),
        ),
      { sensitivity: "internal" },
    ),
  },

  derive: ({ context }) => ({
    isEnterprise: context.account.plan === "enterprise",
    replyStyle:   context.account.tier === "priority" ? "concise" : "standard",
  }),

  policies: {
    require: ["transcript", "account"],
    prefer:  ["recentTickets"],
    budget:  12_000,
  },
});

const { context, trace } = await polo.resolve(supportReply, {
  accountId:  "acc_123",
  transcript: "...",
});

await generateText({
  model,
  system: buildSystemPrompt(context),
  prompt: buildPrompt(context),
});
```

The contract is explicit. The trace proves what happened.

```json
{
  "sources": [
    { "key": "transcript",     "type": "input",  "sensitivity": "restricted" },
    { "key": "account",        "type": "single", "sensitivity": "internal"   },
    {
      "key": "recentTickets",
      "type": "chunks",
      "sensitivity": "internal",
      "chunks": [
        { "included": true,  "score": 0.91 },
        { "included": true,  "score": 0.87 },
        { "included": false, "score": 0.42, "reason": "over_budget" }
      ]
    }
  ],
  "policies": [
    { "source": "transcript",    "action": "required",  "reason": "required by task" },
    { "source": "account",       "action": "required",  "reason": "required by task" },
    { "source": "recentTickets", "action": "preferred", "reason": "preferred for grounding" }
  ],
  "budget": { "max": 12000, "used": 8430 }
}
```

Polo used 8,430 of a 12,000 token budget and can tell you exactly what it left out and why.

---

## The API

Polo has five primitives:

| Primitive | |
|---|---|
| `polo.define()` | Declare the context contract for a task |
| `polo.resolve()` | Resolve context at runtime |
| `polo.input()` | Passthrough from call-time input |
| `polo.source()` | Single async value from anywhere |
| `polo.chunks()` | Ranked multi-block source wrapper |

That is the whole surface. Everything else — dependency ordering, packing, tracing, provenance, chunk dropping — stays internal.

---

## Authoritative by Default

`resolve()` is authoritative.

`context` only contains source keys that policy allowed through. Excluded sources are absent — not nulled, not hidden behind a flag. Absent.

```ts
const { context } = await polo.resolve(generateAINote, {
  encounterId,
  transcript,
});

context.intake; // undefined at runtime when excluded by policy
```

This is what makes Polo a control plane instead of a helper. You cannot accidentally leak an excluded source into a prompt because it is not there.

---

## Quickstart

```
pnpm add @polo/core ai
```

### Define a task

```ts
import { polo } from "@polo/core";
import { prisma } from "@/db";
import { DEFAULT_AI_NOTE_SECTIONS } from "@/ai/defaultAiNoteSections";

const generateAINote = polo.define({
  id: "generate_ai_note",

  sources: {
    transcript: polo.input("transcript", { sensitivity: "phi" }),

    encounter: polo.source(
      async (input) =>
        prisma.encounter.findUniqueOrThrow({
          where: { id: input.encounterId },
          include: {
            patient:  { include: { user: true } },
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
              patientId:   sources.encounter.patientId,
              providerId:  sources.encounter.providerId,
              cancelledAt: null,
              startedAt:   { lt: sources.encounter.startedAt },
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
              where:   { deletedAt: null },
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
    patientType:   context.encounter.patient.isSeen ? "Follow-up" : "New",
    includeIntake: !context.priorNote,
    noteSchema:    buildNoteSchema(context.noteSections),
    styleMirror:   !!context.priorNote,
  }),

  policies: {
    require: ["transcript", "encounter", "noteSections"],
    prefer:  ["priorNote"],
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
  transcript:  "...",
});
```

### Build your prompt normally

```ts
import { generateText, Output, gateway } from "ai";

const model = gateway("anthropic/claude-sonnet-4.6");

await generateText({
  model,
  system: buildSystemPrompt(context),
  prompt: buildPrompt(context),
  output: Output.object({ schema: context.noteSchema }),
});
```

Polo does not own the prompt. It governs the data surface you use to build it.

---

## Concepts

### Sources

Sources fetch data. `polo.input()` is for call-time values. `polo.source()` is for anything async — database reads, HTTP requests, file reads, internal services.

Sources that depend on other sources reference them via the `sources` argument. Polo infers the dependency graph and runs independent sources in parallel automatically.

```ts
// no dependencies, runs immediately
encounter: polo.source(async (input) =>
  prisma.encounter.findUniqueOrThrow({ where: { id: input.encounterId } })
)

// depends on encounter, runs once encounter resolves
priorNote: polo.source(async (_input, sources) =>
  prisma.providerNote.findFirst({
    where: { encounter: { patientId: sources.encounter.patientId } },
  })
)
```

No explicit sequencing. No overfetching.

### Chunks

Use `polo.chunks()` when a source returns multiple ranked blocks. Polo fits as many as the budget allows, drops the rest, and records each decision in the trace.

```ts
guidelines: polo.source(async (_input, sources) =>
  polo.chunks(
    vectorDb.search({ query: sources.transcript, topK: 10 }),
    (item) => ({ content: item.pageContent, score: item.relevanceScore }),
  )
)
```

The `normalize` function maps any vector DB response shape to `{ content, score }`.

### Derive

`derive()` computes plain values from resolved sources. Use it for task-specific values that belong in prompt construction but are not raw source data.

```ts
derive: ({ context }) => ({
  patientType:  context.encounter.patient.isSeen ? "Follow-up" : "New",
  noteSchema:   buildNoteSchema(context.noteSections),
  styleMirror:  !!context.priorNote,
})
```

Derived values are available on `context` after resolution, alongside source data.

### Policies

Policies define the contract for a task.

```ts
policies: {
  require: ["transcript", "encounter"],
  prefer:  ["priorNote", "guidelines"],
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
`exclude` — excludes a source key with a reason, recorded in the trace.  
`budget` — token ceiling for the full context.

> **v0 note:** policies operate on top-level source keys only. If nested data needs separate treatment, promote it to its own source.

---

## Trace Philosophy

Traces are metadata-first by default.

They record source resolution timing, sensitivity, policy decisions, chunk inclusion and dropping, budget usage, and derived values. They do not store raw resolved data unless you explicitly opt in.

That keeps the default safer for sensitive workflows — and makes traces easy to log, store, and inspect across your team.

---

## Fits Your Stack

Polo sits between your data and your model call. Everything else stays yours.

- **AI SDK** — model calls, streaming, tools, UI integration
- **LlamaIndex / LangChain** — use them inside a `polo.source()` or alongside Polo
- **LangSmith / Braintrust** — pass `trace` into your existing observability layer
- **Prisma / Drizzle / any ORM** — `polo.source()` accepts any async function

---

## Open Source and Cloud

### Open source (`@polo/core`)

- Task definitions
- Local resolution
- Authoritative context objects
- Automatic dependency resolution
- Chunk packing and dropping
- Local traces
- BYO model keys and infra

### Polo Cloud

- Hosted trace history
- Compare runs over time
- Shared task definitions across environments
- Managed connectors and secrets
- Regression and drift alerts
- Governance workflows

### Enterprise

- SSO, RBAC, and SCIM
- Audit logs
- VPC / on-prem deployment
- Data residency and retention controls
- Compliance workflows
- Support and SLA

---

## Who It Is For

Polo is for teams shipping AI features in production who need:

- better output quality without changing models
- less prompt glue scattered through application code
- explicit control over what context enters a model call
- auditability when outputs go wrong
- a better way to compare context strategies over time

It is especially useful when context comes from multiple systems, mistakes are expensive, humans review outputs, or compliance matters.

---

## v0 Scope

Polo v0 ships with:

- TypeScript runtime
- Five public primitives
- Authoritative `resolve()`
- Automatic dependency resolution
- Chunk-aware budget packing
- Local traces, metadata-first
- AI SDK compatibility

The goal is simple: make context contracts explicit, enforce them at runtime, and prove what happened after every call.

---

## Why Now

Context engineering is now the consensus bottleneck for production AI.

[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): *"Good context engineering means finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."*

[Cursor](https://cursor.com/blog/dynamic-context-discovery): dynamic context discovery reduced total agent tokens by 46.9% in MCP-tool runs, and can improve response quality by reducing potentially confusing or contradictory information in the context window.

[Claude Code best practices](https://code.claude.com/docs/en/best-practices): *"Claude's context window fills up fast, and performance degrades as it fills. The context window is the most important resource to manage."*

The industry has tools for prompts, retrieval, and observability. What is still missing is a runtime that manages context assembly for production AI — with explicit rules, automatic resolution, and a trace that proves what happened.

Polo is that runtime.

---

## License

MIT