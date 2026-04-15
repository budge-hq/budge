import { describe, expect, it, vi } from "vite-plus/test";
import { text } from "../../src/sources/text.ts";
import type { SearchQuery, SearchMatch } from "../../src/sources/interface.ts";
import type { Chunk } from "../../src/sources/text.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generates a string longer than the default 4000-token threshold.
 * Uses unique words so BM25 has meaningful variance.
 */
function longContent(words: number = 8000): string {
  const base = Array.from(
    { length: words },
    (_, i) => `word${i % 1000}_${Math.floor(i / 1000)}`,
  ).join(" ");
  return base;
}

// ---------------------------------------------------------------------------
// Below-threshold (small content)
// ---------------------------------------------------------------------------

describe("text() — below threshold", () => {
  it("returns an adapter with describe and read", () => {
    const adapter = text("Hello world");
    expect(typeof adapter.describe).toBe("function");
    expect(typeof adapter.read).toBe("function");
  });

  it("does NOT expose list or search", () => {
    const adapter = text("Hello world");
    expect("list" in adapter).toBe(false);
    expect("search" in adapter).toBe(false);
  });

  it("describe() mentions token count, read_source, and the required path", () => {
    const adapter = text("Short text.");
    const desc = adapter.describe();
    expect(desc).toMatch(/\d+ token/);
    expect(desc).toContain('path "text"');
    expect(desc).toContain("read_source");
  });

  it("read('text') returns the content", async () => {
    const adapter = text("inline content");
    await expect(adapter.read!("text")).resolves.toBe("inline content");
  });

  it("read() supports empty string", async () => {
    const adapter = text("");
    await expect(adapter.read!("text")).resolves.toBe("");
  });

  it("read() throws on unknown path", async () => {
    const adapter = text("hello");
    await expect(adapter.read!("other")).rejects.toThrow(/unknown path/i);
  });

  it("chunk: false forces blob mode even for long content", () => {
    const content = longContent();
    const adapter = text(content, { chunk: false });
    expect("list" in adapter).toBe(false);
    expect("search" in adapter).toBe(false);
    expect("read" in adapter).toBe(true);
  });

  it("custom threshold: content at threshold is below-threshold", () => {
    const adapter = text("hello world", { chunkThreshold: 100 });
    // "hello world" is ~3 tokens — well below 100
    expect("list" in adapter).toBe(false);
    expect("search" in adapter).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Above-threshold (chunked content)
// ---------------------------------------------------------------------------

describe("text() — above threshold (chunked)", () => {
  const content = longContent();

  it("returns an adapter with describe, list, read, and search", () => {
    const adapter = text(content);
    expect(typeof adapter.describe).toBe("function");
    expect(typeof adapter.list).toBe("function");
    expect(typeof adapter.read).toBe("function");
    expect(typeof adapter.search).toBe("function");
  });

  it("describe() mentions chunk count and 'search_source'", () => {
    const adapter = text(content);
    const desc = adapter.describe();
    expect(desc).toContain("chunk");
    expect(desc).toContain("search_source");
    expect(desc).toContain("list_source");
    expect(desc).toContain("read_source");
  });

  it("list() returns chunk IDs in order", async () => {
    const adapter = text(content);
    const ids = await adapter.list!();
    expect(ids.length).toBeGreaterThan(1);
    expect(ids[0]).toBe("chunk:0");
    expect(ids[1]).toBe("chunk:1");
    // All IDs follow chunk:N format
    for (const id of ids) {
      expect(id).toMatch(/^chunk:\d+$/);
    }
  });

  it("read(chunkId) returns that chunk's content", async () => {
    const adapter = text(content);
    const ids = await adapter.list!();
    const firstChunk = await adapter.read!(ids[0]!);
    expect(typeof firstChunk).toBe("string");
    expect(firstChunk.length).toBeGreaterThan(0);
  });

  it("all chunks joined reconstruct the original content (no overlap)", async () => {
    // Use fixed strategy with no overlap
    const smallContent = "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(100);
    const adapter = text(smallContent, {
      chunkThreshold: 10,
      chunk: { strategy: "fixed", size: 20, overlap: 0 },
    });
    const ids = await adapter.list!();
    const chunks = await Promise.all(ids.map((id) => adapter.read!(id)));
    const joined = chunks.join(" ").replace(/\s+/g, " ").trim();
    const original = smallContent.replace(/\s+/g, " ").trim();
    expect(joined).toBe(original);
  });

  it("read() throws on unknown chunk ID", async () => {
    const adapter = text(content);
    await expect(adapter.read!("chunk:99999")).rejects.toThrow(/unknown chunk/i);
  });
});

// ---------------------------------------------------------------------------
// search() — BM25
// ---------------------------------------------------------------------------

describe("text() — search() BM25", () => {
  it("returns top-k results", async () => {
    const content = longContent();
    const adapter = text(content);
    const results = await adapter.search!({ text: "word0", k: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("returns results with required SearchMatch fields", async () => {
    const content = longContent();
    const adapter = text(content);
    const results = await adapter.search!({ text: "word500", k: 5 });
    if (results.length > 0) {
      expect(typeof results[0]!.id).toBe("string");
      expect(typeof results[0]!.content).toBe("string");
      expect(typeof results[0]!.score).toBe("number");
      expect(results[0]!.id).toMatch(/^chunk:\d+$/);
    }
  });

  it("returns empty array for a query that matches nothing", async () => {
    const content = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const adapter = text(content, { chunkThreshold: 10 });
    const results = await adapter.search!({ text: "xyzzy_nonexistent_zxqwerty", k: 5 });
    expect(results).toEqual([]);
  });

  it("the most relevant chunk ranks first", async () => {
    // Build content where one section is clearly about a unique topic
    const sections = [
      "The patient received insulin therapy for diabetes management. ".repeat(50),
      "The server logs show high CPU usage during peak hours. ".repeat(50),
      "Financial quarterly earnings exceeded analyst expectations. ".repeat(50),
    ];
    const combined = sections.join("\n\n");
    const adapter = text(combined, { chunkThreshold: 10, chunk: { size: 100 } });

    const results = await adapter.search!({ text: "insulin diabetes therapy", k: 5 });
    expect(results.length).toBeGreaterThan(0);
    // Top result should contain insulin-related content
    expect(results[0]!.content.toLowerCase()).toContain("insulin");
  });
});

// ---------------------------------------------------------------------------
// search() — custom rank function
// ---------------------------------------------------------------------------

describe("text() — custom rank function", () => {
  it("calls custom rank with chunks and query", async () => {
    const content = longContent();
    const rankFn = vi.fn(
      async (_chunks: Chunk[], _query: SearchQuery): Promise<SearchMatch[]> => [
        { id: "chunk:0", content: "custom result", score: 42 },
      ],
    );

    const adapter = text(content, { rank: rankFn });
    const results = await adapter.search!({ text: "anything", k: 5 });

    expect(rankFn).toHaveBeenCalledOnce();
    expect(rankFn).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "chunk:0" })]),
      { text: "anything", k: 5 },
    );
    expect(results).toEqual([{ id: "chunk:0", content: "custom result", score: 42 }]);
  });
});

// ---------------------------------------------------------------------------
// Chunking strategies
// ---------------------------------------------------------------------------

describe("text() — sentence chunking strategy", () => {
  it("splits on sentence boundaries", async () => {
    const content = "First sentence here. Second sentence here. Third sentence here. ".repeat(200);
    const adapter = text(content, {
      chunkThreshold: 10,
      chunk: { strategy: "sentences", size: 50 },
    });
    const ids = await adapter.list!();
    expect(ids.length).toBeGreaterThan(0);
    const first = await adapter.read!(ids[0]!);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("text() — paragraph chunking strategy", () => {
  it("splits on blank lines", async () => {
    const paragraphs = Array.from(
      { length: 50 },
      (_, i) => `Paragraph ${i}: ${"content ".repeat(20)}`,
    ).join("\n\n");
    const adapter = text(paragraphs, {
      chunkThreshold: 10,
      chunk: { strategy: "paragraphs", size: 100 },
    });
    const ids = await adapter.list!();
    expect(ids.length).toBeGreaterThan(0);
    const first = await adapter.read!(ids[0]!);
    expect(first).toContain("Paragraph");
  });

  it("preserves paragraph boundaries (\\n\\n) when merging small paragraphs", async () => {
    // Three short paragraphs that each fit well under the size limit — they
    // will be merged into a single chunk, and the boundary must be \n\n, not " ".
    const content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const adapter = text(content, {
      chunkThreshold: 1, // force chunking
      chunk: { strategy: "paragraphs", size: 200 },
    });
    const ids = await adapter.list!();
    // All three paragraphs fit in one chunk
    expect(ids.length).toBe(1);
    const chunk = await adapter.read!(ids[0]!);
    // Paragraph structure preserved — not collapsed to a single space
    expect(chunk).toContain("\n\n");
    expect(chunk).toContain("First paragraph.");
    expect(chunk).toContain("Second paragraph.");
    expect(chunk).toContain("Third paragraph.");
  });
});

// ---------------------------------------------------------------------------
// Custom threshold
// ---------------------------------------------------------------------------

describe("text() — custom chunk threshold", () => {
  it("very low threshold forces chunking on short content", () => {
    const adapter = text("hello world this is a test", { chunkThreshold: 1 });
    // Even short content is chunked below a threshold of 1 token
    expect("list" in adapter).toBe(true);
    expect("search" in adapter).toBe(true);
  });

  it("very high threshold prevents chunking on long content", () => {
    const adapter = text(longContent(), { chunkThreshold: 999_999 });
    expect("list" in adapter).toBe(false);
    expect("search" in adapter).toBe(false);
  });
});
