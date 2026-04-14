import { describe, expect, it } from "vite-plus/test";
import { buildSystemPrompt } from "../src/agent.ts";
import { buildTools } from "../src/tools.ts";
import { TraceBuilder } from "../src/trace.ts";
import { Truncator } from "../src/truncation.ts";
import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter() {
  return {
    describe: () => "fixture source",
    list: async () => [],
    read: async (path: string) => `contents for ${path}`,
  };
}

const toolDescriptions = (() => {
  const tools = buildTools({
    sources: { docs: makeAdapter() },
    worker: {} as LanguageModel,
    trace: new TraceBuilder("test"),
    truncator: new Truncator({ enabled: false }),
  });
  return {
    read_source: tools.read_source.description ?? "",
    list_source: tools.list_source.description ?? "",
    run_subcall: tools.run_subcall.description ?? "",
    run_subcalls: tools.run_subcalls.description ?? "",
  };
})();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt()", () => {
  const prompt = buildSystemPrompt("- **docs**: fixture source");

  it("contains the word 'parallel'", () => {
    expect(prompt).toContain("parallel");
  });

  it("contains a ## Parallelism section", () => {
    expect(prompt).toContain("## Parallelism");
  });

  it("contains a worked example with read_source", () => {
    expect(prompt).toContain("read_source");
    // The example should demonstrate issuing multiple reads in one step
    expect(prompt).toContain("parallel reads");
  });

  it("contains the antipattern warning", () => {
    expect(prompt).toContain("antipattern");
  });

  it("mentions that multiple tools can be called in a single response", () => {
    expect(prompt).toContain("multiple tools in a single response");
  });

  it("includes the available sources", () => {
    expect(prompt).toContain("fixture source");
  });
});

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

describe("read_source tool description", () => {
  it("encourages parallel calls", () => {
    const { read_source } = toolDescriptions;
    expect(read_source).toContain("parallel");
  });

  it("mentions independent reads", () => {
    const { read_source } = toolDescriptions;
    expect(read_source).toContain("independent");
  });
});

describe("list_source tool description", () => {
  it("encourages parallel calls", () => {
    const { list_source } = toolDescriptions;
    expect(list_source).toContain("parallel");
  });

  it("mentions independent reads", () => {
    const { list_source } = toolDescriptions;
    expect(list_source).toContain("independent");
  });
});
