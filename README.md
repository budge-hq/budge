# Polo

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/polo-hq/polo)

**The best context management framework for agents.**

Polo is the typed runtime that decides what goes into the model’s context window on every turn: which sources to fetch, how they compose, how policy shapes visibility, how a token budget is satisfied, and how the result is serialized into prompts. Each resolution returns a fully typed `context`, optional `{ system, prompt }`, and a `traces` receipt so you can see what the model saw and why.

## The context layer

1. **Sources** — Typed, async data fetchers with dependency resolution (`ValueSource`, `RAGSource`, `InputSource`). The DAG and wave execution live here; it is already Polo’s strongest component.

2. **Composition** — How sources are grouped, reused, and shared across windows. The `sourceSet` primitive: without it you only have sources; with it you have reusable context architecture.

3. **Budgeting** — Token-aware fitting. Not only “trim when over,” but the full priority cascade (require, prefer, drop, trim chunks), pluggable strategies such as `score_per_token`, and TOON serialization as part of fitting more into the budget.

4. **Policy** — Rules for what the model should and should not see at runtime (`require`, `prefer`, `exclude`). Separate from budgeting: policy is intent (this source must appear); budgeting is constraint (fit within N tokens). They interact but stay distinct.

5. **History** — Turn-level context: what accumulates across the agent loop. This belongs on the window, not as a separate primitive. Reversible edits (clear tool results, clear reasoning blocks, sliding window) live here.

6. **Compaction** — The lossy tier when reversible edits are not enough: LLM summarization, structured persistent summaries, anchored merging, pluggable summarizers. This is where a managed cloud product plugs in.

7. **Traces** — Every resolution produces a receipt: timing, token counts, compression ratios, policy decisions, inclusion and exclusion reasons. The base for observability and, eventually, closed-loop improvement.

8. **Template** — How resolved context becomes a prompt: proxy-based auto-serialization, TOON encoding, system vs user structure. Poor serialization wastes budget even when sourcing and policy are perfect.

---

## Installation

```sh
pnpm add @polo/core zod
```

Examples below use `zod` for schemas, but Polo works with Standard Schema-compatible validators.

## Usage

### Create instance

```ts
import { createPolo } from "@polo/core";

export const polo = createPolo();
```

`createPolo()` gives you an isolated runtime surface. You can also pass runtime hooks like `logger` and `onTrace` if you want to forward traces into your own observability layer.

### Create source sets

```ts
import { registerSources } from "@polo/core";
import { z } from "zod";

const supportReplyInputSchema = z.object({
  accountId: z.string(),
  transcript: z.string(),
});

const accountSourceInputSchema = z.object({
  accountId: z.string(),
});

const transcriptSourceInputSchema = z.object({
  transcript: z.string(),
});

const accountSourceSet = polo.sourceSet(({ source }) => {
  const account = source(accountSourceInputSchema, {
    tags: ["internal"],
    async resolve({ input }) {
      return db.getAccount(input.accountId);
    },
  });

  const billingNotes = source(
    accountSourceInputSchema,
    { account },
    {
      tags: ["billing"],
      async resolve({ account }) {
        return db.getBillingNotes(account.id);
      },
    },
  );

  return { account, billingNotes };
});

const ticketSourceSet = polo.sourceSet(({ source }) => {
  const recentTickets = source.rag(
    transcriptSourceInputSchema,
    { account: accountSourceSet.account },
    {
      tags: ["internal"],
      async resolve({ input, account }) {
        return vectorDb.searchTickets(account.id, input.transcript);
      },
      normalize(item) {
        return {
          content: item.pageContent,
          score: item.relevanceScore,
          metadata: { ticketId: item.id },
        };
      },
    },
  );

  return { recentTickets };
});

const supportReplySources = registerSources(accountSourceSet, ticketSourceSet);
```

Use `polo.sourceSet(...)` to author reusable resolver/chunk sources and `registerSources(...)` to assemble the final shared registry. Input passthroughs like `transcript` stay local to each window declaration.

Dependencies are declared by referencing source handles like `{ account }` or `{ account: accountSourceSet.account }`. Polo validates that graph during source registration, then checks that every `polo.window(...)` selects a dependency-closed source set.

Window declarations may alias selected source keys, but dependency declarations inside `source(..., deps, config)` and `source.rag(..., deps, config)` (within `polo.sourceSet`) must currently use the referenced source’s own key.

Source handles are single-owner objects: create them inside one `polo.sourceSet(...)`, then reference them from other sets as dependencies instead of re-exporting the same handle from multiple sets.

### Declare a context window

The core API is `polo.window({ input, id, sources, policies, … })`: one object describes a stable window identifier, sources, optional `derive` / `template`, and a nested `policies` block (`require`, `prefer`, `exclude`, `budget`) for a single context window. The return value is an async function you call each turn with validated input.

```ts
const transcript = polo.input("transcript", { tags: ["restricted"] });

const runSupportReply = polo.window({
  input: supportReplyInputSchema,
  id: "support_reply",
  sources: {
    transcript,
    account: supportReplySources.account,
    billingNotes: supportReplySources.billingNotes,
    recentTickets: supportReplySources.recentTickets,
  },

  derive: (ctx) => ({
    isEnterprise: ctx.account.plan === "enterprise",
    replyStyle: ctx.account.tier === "priority" ? "concise" : "standard",
    mentionsBilling: /\b(invoice|refund|charge|billing)\b/i.test(ctx.transcript),
  }),

  policies: {
    require: ["transcript", "account"],
    prefer: ["recentTickets", "billingNotes"],
    exclude: [
      (ctx) =>
        !ctx.mentionsBilling
          ? {
              source: "billingNotes",
              reason: "billing notes are excluded unless the transcript is billing-related",
            }
          : false,
    ],
    budget: 110,
  },

  template: (context) => ({
    system: `You are a support engineer drafting a customer reply. Use a ${context.replyStyle} tone. ${
      context.isEnterprise
        ? "Prioritize urgency and ownership."
        : "Keep the reply practical and direct."
    }`,
    prompt: `Customer message:\n${context.transcript}\n\nAccount:\n${context.account}${
      context.recentTickets?.length
        ? `\n\nRecent tickets:\n${context.recentTickets.map((ticket) => ticket.content).join("\n")}`
        : ""
    }\n\nBilling notes:\n${context.billingNotes ?? "N/A"}`,
  }),
});
```

`id` is required and should remain stable for the logical window definition. Polo Cloud uses this value to group runs under the same window.

The `template` function receives the fully resolved, policy-gated template context and returns plain `{ system, prompt }` strings. When you interpolate objects or arrays like `${context.account}`, Polo intercepts that coercion under the hood, serializes the raw value with [TOON](https://github.com/toon-format/toon), and only then measures the final prompt. For chunk sources, direct interpolation serializes the full chunk objects; map to `chunk.content` when you only want the text. If you need the original value for custom formatting, use `context.raw`.

### Resolve prompt and context

```ts
const { context, prompt, traces } = await runSupportReply({
  accountId: "acc_123",
  transcript: "Our webhook deliveries have been timing out in production since yesterday's deploy.",
});

// Pass directly to your model
const { text } = await generateText({
  model: "openai/gpt-5.4",
  system: prompt.system,
  prompt: prompt.prompt,
});

// Inspect the compression
console.log(
  `Compressed to ${((traces.prompt?.includedCompressionRatio ?? 0) * 100).toFixed(1)}% fewer tokens than the final included context`,
);
```

`prompt` is absent when no `template` is configured — the resolved `context` object is still available for manual prompt construction.

---

## API

| API                                     | Description                                                          |
| --------------------------------------- | -------------------------------------------------------------------- |
| `createPolo(options?)`                  | Create an isolated Polo runtime                                      |
| `polo.input(key, options?)`             | Passthrough from call-time input                                     |
| `polo.sourceSet(({ source }) => …)`     | Define reusable resolver/chunk sources (`source`, `source.rag`)      |
| `registerSources(...sourceSets)`        | Register a composed shared source registry                           |
| `polo.window({ input, sources, policies, … })` | Declare a window; returns async `(input) => result`          |
| `source(inputSchema, config)`           | Resolve a single async value                                         |
| `source(inputSchema, deps, config)`     | Resolve a value that depends on other sources                        |
| `source.rag(inputSchema, config)`       | Resolve ranked multi-block context                                   |
| `source.rag(inputSchema, deps, config)` | Resolve ranked blocks with dependencies                              |

---

## Templates

Add a `template` function to any window to have Polo construct the prompt:

```ts
template: (context) => ({
  system: `System instructions for ${context.account}`,
  prompt: `User-facing content:\n${context.transcript}`,
}),
```

`context` inside templates is render-aware:

- interpolate objects and arrays directly: `${context.account}`, `${context.recentTickets}`
- access fields normally for logic: `context.account.plan`, `context.recentTickets?.length`
- use `context.raw` when you need the original JS value for custom formatting: `JSON.stringify(context.raw.account)`
- for chunk sources, map to `chunk.content` when you only want text in the prompt

### Budget fitting

When a budget is set, Polo renders the template, counts exact tokens, and if over budget:

1. **Drop default-included non-chunk sources** (lowest priority, dropped whole)
2. **Drop preferred non-chunk sources** (dropped whole)
3. **Trim chunks one-at-a-time** from chunk sources, lowest score first
4. **Drop chunk sources whole** as a last resort

Required sources are never dropped. Each dropped source is recorded in the trace.

## Sources

Use `polo.input()` for call-time input passthroughs. Inside `polo.sourceSet(({ source }) => …)`, `source()` wraps any async resolver: database queries, HTTP requests, file reads, whatever you already have.

Resolvers receive a single argument object with:

- `input`: window input narrowed by the source’s schema
- direct dependency values, flattened onto the resolver args

Polo builds the dependency graph from the source handles you pass in the `deps` object and validates it during source registration and window declaration.

That gives you two safety nets:

- type errors in `polo.window(...)` when a window selects a dependent source without its prerequisites
- runtime errors with clear source names if JavaScript or ignored type errors bypass the static check

Dependency validation follows the referenced source handles’ internal ids, not the window’s selected key names.

```ts
account: source(accountSourceInputSchema, {
  async resolve({ input }) {
    return db.getAccount(input.accountId);
  },
});

billingNotes: source(
  accountSourceInputSchema,
  { account },
  {
    async resolve({ account }) {
      return db.getBillingNotes(account.id);
    },
  },
);
```

## RAG Sources

`source.rag()` is for sources that return multiple ranked blocks. Polo fits as many as the token budget allows, drops the rest, and records each decision in the trace.

```ts
recentTickets: source.rag(
  transcriptSourceInputSchema,
  { account },
  {
    async resolve({ input, account }) {
      return vectorDb.searchTickets(account.id, input.transcript);
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

## Derive

`derive()` computes values from resolved sources. The result is merged onto `context` alongside source data.

```ts
derive: (ctx) => ({
  isEnterprise: ctx.account.plan === "enterprise",
  replyStyle: ctx.account.tier === "priority" ? "concise" : "standard",
  mentionsBilling: /\b(invoice|refund|charge|billing)\b/i.test(ctx.transcript),
}),
```

## Policies

```ts
policies: {
  require: ["transcript", "account"],
  prefer: ["recentTickets", "billingNotes"],
  exclude: [
    (ctx) =>
      !ctx.mentionsBilling
        ? {
            source: "billingNotes",
            reason: "billing notes are excluded unless the transcript is billing-related",
          }
        : false,
  ],
  budget: 110,
},
```

`policies.require` — must resolve or the window’s async call throws.  
`policies.prefer` — included if it fits in budget.  
`policies.exclude` — excludes a source with a reason, recorded in the trace.  
`policies.budget` — token ceiling. Without a template, tokens are estimated per-source using TOON serialization at 96% accuracy via [tokenx](https://github.com/johannschopplich/tokenx). With a template, Polo measures the exact rendered token count.

> **v0:** policies operate on top-level source keys only. If nested data needs separate treatment, promote it to its own source.

## Trace

Calling the async function returned by `polo.window()` yields `traces` alongside `context` and `prompt`. The trace records source resolution timing, tags, policy decisions, chunk inclusion, budget usage, and — when a template is used — exact prompt-level token metrics. Raw resolved values are not stored.

```json
{
  "sources": [
    { "key": "transcript", "type": "input", "tags": ["restricted"] },
    { "key": "account", "type": "value", "tags": ["internal"], "durationMs": 1 },
    {
      "key": "billingNotes",
      "type": "value",
      "tags": ["billing"],
      "durationMs": 0
    },
    {
      "key": "recentTickets",
      "type": "rag",
      "tags": ["internal"],
      "items": [
        { "included": true, "score": 0.91 },
        { "included": false, "score": 0.14, "reason": "over_budget" }
      ]
    }
  ],
  "policies": [
    { "source": "transcript", "action": "required", "reason": "required by policy" },
    {
      "source": "billingNotes",
      "action": "excluded",
      "reason": "billing notes are excluded unless the transcript is billing-related"
    }
  ],
  "budget": { "max": 110, "used": 98 },
  "prompt": {
    "systemTokens": 22,
    "promptTokens": 76,
    "totalTokens": 98,
    "rawContextTokens": 163,
    "includedContextTokens": 121,
    "compressionRatio": 0.399,
    "includedCompressionRatio": 0.19
  }
}
```

`prompt.rawContextTokens` measures the naive JSON baseline for all resolved sources before policy exclusions or budget fitting.

`prompt.includedContextTokens` measures the naive JSON baseline for the final template context after policy exclusions and budget fitting.

`prompt.compressionRatio` is `max(0, 1 - totalTokens / rawContextTokens)` — the clamped fraction of tokens saved versus all resolved sources.

`prompt.includedCompressionRatio` is `max(0, 1 - totalTokens / includedContextTokens)` — the clamped fraction of tokens saved versus the final included context. This is usually the better metric for comparing prompt compaction strategies.

---

## Why Polo

Hand-rolled context assembly usually means ad hoc fetches, everything stuffed into the prompt, and no durable record of what the model actually saw. That breaks down as soon as you need reliability, cost control, or debugging across agent turns.

Polo gives you:

- **consistent windows** — the same policies, sources, and budget every resolution
- **explicit contracts** — input schemas, source schemas, and policies live with the window
- **typed context** — `context` is fully typed from your source definitions, no casting
- **validated dependency graphs** — sources run in parallel waves; missing prerequisites are caught before runtime work starts
- **token-efficient serialization** — TOON encoding delivers ~40% fewer tokens than JSON on structured data, with equal or better model accuracy
- **measurable optimization** — traces include full-resolution and final-included compression metrics for comparing strategies
- **debuggable runs** — when outputs go wrong, the trace shows what the model saw and why

---

## Fits Your Stack

Polo is the context layer in front of your existing AI stack — not a replacement for it.

- **AI SDK** — pass `context` (or `prompt.system` / `prompt.prompt` when using a template) directly to `generateText`, `generateObject`, or streaming APIs
- **LangChain / LangGraph** — call your window’s async runner inside `dynamicSystemPromptMiddleware` or `wrapModelCall`; Polo owns context, your framework owns the loop
- **Prisma / Drizzle / any ORM** — `source(inputSchema, { resolve })` (inside `sourceSet`) wraps any async resolver with minimal ceremony
- **LangSmith / Braintrust** — forward `traces` into your observability pipeline; it carries timings, policy decisions, chunk records, and prompt compression metrics

---

## License

MIT
