# Support Reply Example

This example shows the current `@budge/core` API:

- reusable source handles defined once
- `budge.window({ id, input, sources })`
- dependency-aware source composition through source handles
- `.resolve({ input })` at runtime
- `traces` as the receipt for what Budge resolved
- prompt assembly outside Budge

## Files

- `src/sourceRegistry.ts` defines reusable `value` and `rag` sources
- `src/supportReply.ts` declares the window, builds the prompt, and summarizes traces
- `src/index.ts` runs the example and prints the resolved context, prompt, and traces

## Run

From this example directory (`examples/support-reply`):

```bash
vp pack
vp run demo
```

The demo resolves a support transcript, builds a prompt from the returned `context`, and prints the traces Budge produced for the turn.
