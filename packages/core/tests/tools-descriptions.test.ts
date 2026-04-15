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
    list: async () => [] as string[],
    read: async (path: string) => `contents for ${path}`,
  };
}

const toolDescriptions = (() => {
  const tools = buildTools({
    sources: { docs: makeAdapter() },
    worker: {} as LanguageModel,
    trace: new TraceBuilder("test"),
    truncator: new Truncator({ enabled: false }),
  }) as Record<string, { description?: string }>;
  return {
    read_source: tools.read_source?.description ?? "",
    list_source: tools.list_source?.description ?? "",
    run_subcall: tools.run_subcall?.description ?? "",
    run_subcalls: tools.run_subcalls?.description ?? "",
  };
})();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt()", () => {
  const fullCapabilities = { hasAnyList: true, hasAnyRead: true, hasAnySearch: true };
  const prompt = buildSystemPrompt("- **docs**: fixture source", fullCapabilities);

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

describe("buildSystemPrompt() — tools-only sources", () => {
  const prompt = buildSystemPrompt("- **db**: tools-only source", {
    hasAnyList: false,
    hasAnyRead: false,
    hasAnySearch: false,
  });

  it("does not mention list_source", () => {
    expect(prompt).not.toContain("list_source");
  });

  it("does not mention read_source", () => {
    expect(prompt).not.toContain("read_source");
  });

  it("does not mention search_source", () => {
    expect(prompt).not.toContain("search_source");
  });

  it("does not mention run_subcall (requires read)", () => {
    expect(prompt).not.toContain("run_subcall");
  });

  it("still includes finish instruction", () => {
    expect(prompt).toContain("finish");
  });

  it("still includes the source description", () => {
    expect(prompt).toContain("tools-only source");
  });
});

describe("buildSystemPrompt() — search-only sources", () => {
  const prompt = buildSystemPrompt("- **notes**: search-only source", {
    hasAnyList: false,
    hasAnyRead: false,
    hasAnySearch: true,
  });

  it("mentions search_source", () => {
    expect(prompt).toContain("search_source");
  });

  it("does not mention list_source", () => {
    expect(prompt).not.toContain("list_source");
  });

  it("does not mention read_source", () => {
    expect(prompt).not.toContain("read_source");
  });

  it("does not include the search+subcall example (no read = no subcalls)", () => {
    expect(prompt).not.toContain("run_subcall");
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
