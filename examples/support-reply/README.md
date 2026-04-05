# Support Reply Example

This example shows a practical, end-to-end `@polo/core` context window for
generating a support reply prompt under a strict token budget.

It demonstrates:

- passthrough input sources via `polo.input()`
- resolver sources for account and billing context
- chunk sources for ranked ticket retrieval
- `derive()` for prompt-ready flags (`isEnterprise`, `replyStyle`, `mentionsBilling`)
- nested policy controls via `policies: { require, prefer, exclude, budget }`
- trace inspection for policy decisions and compression metrics

## Files

- `src/sourceRegistry.ts` defines reusable sources
- `src/supportReply.ts` declares the context window, policies, template, and trace summary helper
- `src/index.ts` runs the demo and prints context/prompt/trace output

## Run

From this example directory (`examples/support-reply`):

```bash
vp pack
vp run demo
```

The demo resolves an input transcript and prints:

- the final authoritative context keys
- a sample system prompt
- a sample user prompt
- a human-readable trace summary
- the full trace JSON

## What to look for

- `billingNotes` is excluded unless the transcript is billing-related.
- lower-ranked ticket chunks may be trimmed when over budget.
- trace output shows exactly what was included, excluded, or dropped.
