# @polo/core

Typed context assembly for production AI apps.

`@polo/core` lets you declare where model context comes from, how it is filtered,
and how it must fit within a token budget. At runtime, Polo resolves sources,
applies policies, and returns a typed `context` object (and optional prompt)
plus a detailed `trace` for observability.

## Install

```bash
pnpm add @polo/core zod
```

`zod` is shown in examples, but any Standard Schema-compatible validator works.

## Quick Start

```ts
import { createPolo } from "@polo/core";
import { z } from "zod";

const polo = createPolo();

const taskInput = z.object({
  accountId: z.string(),
  transcript: z.string(),
});

const supportReply = polo.define(taskInput, {
  id: "support_reply",
  sources: {
    transcript: polo.source.fromInput("transcript", { tags: ["restricted"] }),
    account: polo.source(z.object({ accountId: z.string() }), {
      tags: ["internal"],
      async resolve({ input }) {
        return db.getAccount(input.accountId);
      },
    }),
  },
  policies: {
    require: ["transcript", "account"],
    budget: 300,
  },
  template: ({ context }) => ({
    system: "You are a support engineer.",
    prompt: `Customer message:\n${context.transcript}\n\nAccount:\n${context.account}`,
  }),
});

const { context, prompt, trace } = await polo.resolve(supportReply, {
  accountId: "acc_123",
  transcript: "Our webhook deliveries are timing out.",
});
```

## Core Concepts

- `polo.source.fromInput()` passes through call-time input fields.
- `polo.source()` resolves async values (DB, APIs, files, etc.).
- `polo.source.rag()` resolves ranked chunk lists that can be trimmed by budget.
- `polo.source.rag()` also supports staged pipelines via `retrieve`, `rerank`, and `compress` hooks.
- `derive()` adds computed values to the final context.
- `policies.require` enforces must-have keys; `policies.prefer` marks nice-to-have keys.
- `policies.exclude` applies runtime exclusion logic with auditable reasons.
- `template` renders `{ system, prompt }` and enables exact prompt-token measurement.

## Return Value

`polo.resolve()` returns:

- `context`: final typed context after source resolution and policy application.
- `prompt`: rendered `{ system, prompt }` when a template is defined.
- `trace`: source timings, budget decisions, policy records, and prompt token metrics.

## Local Development

From this package directory (`packages/core`):

```bash
vp install
vp test
vp check
vp pack
```

## Example

See the working end-to-end example in
`examples/support-reply/README.md`.
