# Polo

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/polo-hq/polo)

Polo is a typed context assembly runtime for production AI. It resolves context sources, enforces token budgets, and returns a fully typed `context` object ready to use in your prompt. Optionally, define a `template` to have Polo call your rendering function, measure the exact token cost against the budget, and report how much it compressed versus the raw data baseline — the foundation for measurable prompt experimentation.

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

const accountSourceSet = polo.sourceSet((sources) => {
  const account = sources.value(accountSourceInputSchema, {
    tags: ["internal"],
    async resolve({ input }) {
      return db.getAccount(input.accountId);
    },
  });

  const billingNotes = sources.value(accountSourceInputSchema, { account }, {
    tags: ["billing"],
    async resolve({ account }) {
      return db.getBillingNotes(account.id);
    },
  });

  return { account, billingNotes };
});

const ticketSourceSet = polo.sourceSet((sources) => {
  const recentTickets = sources.chunks(
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

Use `polo.sourceSet(...)` to author reusable resolver/chunk sources and `registerSources(...)` to assemble the final shared registry. Input passthroughs like `transcript` stay local to each task definition.

Dependencies are declared by referencing source handles like `{ account }` or `{ account: accountSourceSet.account }`. Polo validates that graph during source registration, then checks that every task selects a dependency-closed source set during `polo.define(...)`.

Task definitions may alias selected source keys, but dependency declarations inside `polo.source(..., deps, config)` and `polo.source.chunks(..., deps, config)` must currently use the referenced source's own key.

Source handles are single-owner objects: create them inside one `polo.sourceSet(...)`, then reference them from other sets as dependencies instead of re-exporting the same handle from multiple sets.

### Define tasks with a template

```ts
const supportReply = polo.define(supportReplyInputSchema, {
  id: "support_reply",
  sources: {
    transcript: polo.source.fromInput("transcript", { tags: ["restricted"] }),
    account: supportReplySources.account,
    billingNotes: supportReplySources.billingNotes,
    recentTickets: supportReplySources.recentTickets,
  },

  derive: ({ context }) => ({
    isEnterprise: context.account.plan === "enterprise",
    replyStyle: context.account.tier === "priority" ? "concise" : "standard",
    mentionsBilling: /\b(invoice|refund|charge|billing)\b/i.test(context.transcript),
  }),

  policies: {
    require: ["transcript", "account"],
    prefer: ["recentTickets", "billingNotes"],
    exclude: [
      ({ context }) =>
        !context.mentionsBilling
          ? {
              source: "billingNotes",
              reason: "billing notes are excluded unless the transcript is billing-related",
            }
          : false,
    ],
    budget: 110,
  },

  template: ({ context }) => ({
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

The `template` function receives the fully resolved, policy-gated `context` and returns plain `{ system, prompt }` strings. When you interpolate objects or arrays like `${context.account}`, Polo intercepts that coercion under the hood, serializes the raw value with [TOON](https://github.com/toon-format/toon), and only then measures the final prompt. For chunk sources, direct interpolation serializes the full chunk objects; map to `chunk.content` when you only want the text. If you need the original value for custom formatting, use `context.raw`.

### Resolve prompt and context

```ts
const { context, prompt, trace } = await polo.resolve(supportReply, {
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
  `Compressed to ${(trace.prompt.includedCompressionRatio * 100).toFixed(1)}% fewer tokens than the final included context`,
);
```

`prompt` is absent when no `template` is defined — the resolved `context` object is still available for manual prompt construction.

---

## API

| API | Description |
| --- | --- |
| `createPolo(options?)` | Create an isolated Polo runtime |
| `polo.sourceSet(builder)` | Define a reusable shared source fragment |
| `registerSources(...sourceSets)` | Register a composed shared source registry |
| `polo.define(inputSchema, config)` | Declare the context contract for a task |
| `polo.resolve(definition, input)` | Resolve context and prompt at runtime |
| `polo.source.fromInput(key, options?)` | Passthrough from call-time input |
| `polo.source(inputSchema, config)` | Resolve a single async value |
| `polo.source(inputSchema, deps, config)` | Resolve a value that depends on other sources |
| `polo.source.chunks(inputSchema, config)` | Resolve ranked multi-block context |
| `polo.source.chunks(inputSchema, deps, config)` | Resolve ranked blocks with dependencies |

---

## Templates

Add a `template` function to any definition to have Polo construct the prompt:

```ts
template: ({ context }) => ({
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

`polo.source.fromInput()` passes through a value from task input. `polo.source()` wraps any async resolver: database queries, HTTP requests, file reads, whatever you already have.

Resolvers receive a single argument object with:

- `input`: task input narrowed by the source's schema
- direct dependency values, flattened onto the resolver args

Polo builds the dependency graph from the source handles you pass in the `deps` object and validates it during source registration and task definition.

That gives you two safety nets:

- type errors in `polo.define(...)` when a task selects a dependent source without its prerequisites
- runtime errors with clear source names if JavaScript or ignored type errors bypass the static check

Dependency validation follows the referenced source handles' internal ids, not the task's selected key names.

```ts
account: polo.source(accountSourceInputSchema, {
  async resolve({ input }) {
    return db.getAccount(input.accountId);
  },
});

billingNotes: polo.source(accountSourceInputSchema, { account }, {
  async resolve({ account }) {
    return db.getBillingNotes(account.id);
  },
});
```

## Chunks

`polo.source.chunks()` is for sources that return multiple ranked blocks. Polo fits as many as the token budget allows, drops the rest, and records each decision in the trace.

```ts
recentTickets: polo.source.chunks(transcriptSourceInputSchema, { account }, {
  async resolve({ input, account }) {
    return vectorDb.searchTickets(account.id, input.transcript);
  },
  normalize(item) {
    return {
      content: item.pageContent,
      score: item.relevanceScore,
    };
  },
});
```

## Derive

`derive()` computes values from resolved sources. The result is merged onto `context` alongside source data.

```ts
derive: ({ context }) => ({
  isEnterprise: context.account.plan === "enterprise",
  replyStyle: context.account.tier === "priority" ? "concise" : "standard",
  mentionsBilling: /\b(invoice|refund|charge|billing)\b/i.test(context.transcript),
});
```

## Policies

```ts
policies: {
  require: ["transcript", "account"],
  prefer:  ["recentTickets", "billingNotes"],
  exclude: [
    ({ context }) =>
      !context.mentionsBilling
        ? {
            source: "billingNotes",
            reason: "billing notes are excluded unless the transcript is billing-related",
          }
        : false,
  ],
  budget: 110,
}
```

`require` — must resolve or `polo.resolve()` throws.  
`prefer` — included if it fits in budget.  
`exclude` — excludes a source with a reason, recorded in the trace.  
`budget` — token ceiling. Without a template, tokens are estimated per-source using TOON serialization at 96% accuracy via [tokenx](https://github.com/johannschopplich/tokenx). With a template, Polo measures the exact rendered token count.

> **v0:** policies operate on top-level source keys only. If nested data needs separate treatment, promote it to its own source.

## Trace

`polo.resolve()` returns a `trace` alongside `context` and `prompt`. The trace records source resolution timing, tags, policy decisions, chunk inclusion, budget usage, and — when a template is used — exact prompt-level token metrics. Raw resolved values are not stored.

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
      "type": "chunks",
      "tags": ["internal"],
      "chunks": [
        { "included": true, "score": 0.91 },
        { "included": false, "score": 0.14, "reason": "over_budget" }
      ]
    }
  ],
  "policies": [
    { "source": "transcript", "action": "required", "reason": "required by task" },
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

Context assembly is usually handwritten glue — sources fetched manually, included unconditionally, with no token budget and no record of what the model actually saw. This works fine until outputs go wrong or costs spiral and you can't tell why.

Polo gives you:

- **consistent outputs** — same policies run every time, same sources, same budget
- **explicit contracts** — input schemas, source schemas, and policies live next to the task
- **typed context** — `context` is fully typed from your source definitions, no casting
- **validated dependency graphs** — sources run in parallel waves, and missing prerequisites are caught before runtime work starts
- **token-efficient serialization** — TOON encoding delivers ~40% fewer tokens than JSON on structured data, with equal or better model accuracy
- **measurable optimization** — prompt traces include both full-resolution and final-included compression metrics for A/B testing prompt strategies
- **debuggable** — when outputs go wrong, the trace tells you exactly what the model saw

---

## Fits Your Stack

Polo is the data layer that feeds your existing AI stack — not a replacement for it.

- **AI SDK** — pass `context` (or `prompt.system` / `prompt.prompt` when using a template) directly to `generateText`, `generateObject`, or streaming APIs
- **LangChain / LangGraph** — drop Polo's `polo.resolve()` inside a `dynamicSystemPromptMiddleware` or `wrapModelCall` hook; Polo handles the data surface, LangChain handles the agent loop
- **Prisma / Drizzle / any ORM** — `polo.source(inputSchema, { resolve })` wraps any async resolver with no ceremony
- **LangSmith / Braintrust** — forward `trace` to your existing observability layer; it contains source timings, policy decisions, chunk records, and prompt compression metrics

---

## License

MIT
