# Budge Evals

Budge vs. full-context-dump baseline evaluation suite using [promptfoo](https://promptfoo.dev).

## Structure

```
evals/
  promptfooconfig.yaml     # eval definition — providers, prompts, test cases
  providers/
    budge.ts               # custom provider: wraps budge.prepare()
    baseline.ts            # custom provider: naive full-context-dump
  results/                 # output from eval runs (gitignored)
```

## Setup

```bash
cd evals
npm init -y
npm install promptfoo @ai-sdk/anthropic ai
```

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Make sure `packages/core` is built:

```bash
cd ../packages/core
pnpm build
cd ../../evals
```

## Running

```bash
# Run all test cases against both providers
npx promptfoo eval

# Open the results UI
npx promptfoo view

# Run a single test by description (useful during iteration)
npx promptfoo eval --filter-description "five tools"
```

## What you're measuring

Each test case runs against both `budge` and `baseline (full-context-dump)`.

**budge**: calls `budge.prepare()` with `source.fs` pointed at `packages/core/src`. The orchestrator navigates lazily — only reads what's relevant.

**baseline**: reads every `.ts` file upfront and stuffs them all into a single system prompt, then calls the model once.

### Key metrics to compare in the UI

| Metric             | Where to find it                                             |
| ------------------ | ------------------------------------------------------------ |
| Answer correctness | Pass/fail on `contains` + `llm-rubric` assertions            |
| Total tokens       | `tokenUsage.total` column                                    |
| Subcalls spawned   | `metadata.totalSubcalls` (budge only)                        |
| Wall time          | `metadata.durationMs`                                        |
| Finish reason      | `metadata.finishReason` (`finish`, `max_steps`, `no_finish`) |
| Tool call count    | `metadata.toolCallCount` (budge only)                        |

The story you're trying to tell: **budge matches baseline quality at significantly lower token cost**.

## Adding test cases

Edit `promptfooconfig.yaml` and add to the `tests` array. Prefer `icontains` assertions for things you know with certainty are in the correct answer (function names, file names, specific values). Use `llm-rubric` only for reasoning-quality checks where ground truth is fuzzy.

## Switching to Tono

Update the `root` in both provider configs:

```yaml
config:
  root: "../../path/to/tono/src"
  include: [".ts", ".tsx"]
```

And replace the test cases with Tono-specific tasks.
