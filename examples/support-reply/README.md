# Support Reply Example

This example shows the M1 `@budge/core` API:

- reusable source handles defined once
- `budge.window({ id, input, maxTokens, compose })`
- `use(source, input)` inside `compose`
- `.resolve({ input })` at runtime
- `trace` as the receipt for what Budge resolved and measured

## Files

- `src/sourceRegistry.ts` defines reusable `value` and `rag` sources
- `src/supportReply.ts` declares the window and a small trace-summary helper
- `src/index.ts` runs the example and prints the rendered prompt plus trace

## Run

From this example directory (`examples/support-reply`):

```bash
vp pack
vp run demo
```

The demo resolves a support transcript, renders `system` and `prompt`, and prints the trace Budge produced for the turn.
