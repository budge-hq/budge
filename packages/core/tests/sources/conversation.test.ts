import { describe, expect, it } from "vite-plus/test";
import { ConversationAdapter, type ConversationMessage } from "../../src/sources/conversation.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as ConversationMessage["role"],
    content: `Message ${i}`,
    createdAt: new Date(2026, 0, i + 1), // Jan 1, 2, 3 ... 2026
  }));
}

// ---------------------------------------------------------------------------
// describe()
// ---------------------------------------------------------------------------

describe("ConversationAdapter.describe()", () => {
  it("includes the message count", () => {
    const adapter = new ConversationAdapter(makeMessages(10));
    expect(adapter.describe()).toContain("10 messages");
  });

  it("uses singular for one message", () => {
    const adapter = new ConversationAdapter(makeMessages(1));
    expect(adapter.describe()).toContain("1 message");
    expect(adapter.describe()).not.toContain("1 messages");
  });

  it("includes date range when createdAt is present", () => {
    const adapter = new ConversationAdapter(makeMessages(5));
    const desc = adapter.describe();
    expect(desc).toContain("2026"); // both dates are in 2026
  });

  it("omits date range for messages without createdAt", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const adapter = new ConversationAdapter(messages);
    const desc = adapter.describe();
    expect(desc).toContain("2 messages");
    // No date range since no createdAt
    expect(desc).not.toContain("–");
  });

  it("includes role summary", () => {
    const adapter = new ConversationAdapter(makeMessages(4));
    const desc = adapter.describe();
    // 2 user, 2 assistant
    expect(desc).toContain("user");
    expect(desc).toContain("assistant");
  });

  it("handles empty messages", () => {
    const adapter = new ConversationAdapter([]);
    expect(adapter.describe()).toContain("empty");
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("ConversationAdapter.list()", () => {
  it("returns indices as strings", async () => {
    const adapter = new ConversationAdapter(makeMessages(3));
    const items = await adapter.list();
    expect(items).toEqual(["0", "1", "2"]);
  });

  it("returns empty array for empty conversation", async () => {
    const adapter = new ConversationAdapter([]);
    expect(await adapter.list()).toEqual([]);
  });

  it("path argument is ignored", async () => {
    const adapter = new ConversationAdapter(makeMessages(3));
    const withPath = await adapter.list("anything");
    const withoutPath = await adapter.list();
    expect(withPath).toEqual(withoutPath);
  });
});

// ---------------------------------------------------------------------------
// read() — single index
// ---------------------------------------------------------------------------

describe("ConversationAdapter.read() — single index", () => {
  it("reads a single message by index", async () => {
    const adapter = new ConversationAdapter(makeMessages(5));
    const raw = await adapter.read("2");
    const parsed = JSON.parse(raw) as Array<{ index: number; role: string; content: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.index).toBe(2);
    expect(parsed[0]!.content).toBe("Message 2");
  });

  it("includes createdAt when present", async () => {
    const adapter = new ConversationAdapter(makeMessages(3));
    const raw = await adapter.read("0");
    const parsed = JSON.parse(raw) as Array<{ createdAt?: string }>;
    expect(parsed[0]!.createdAt).toBeDefined();
  });

  it("throws for out-of-range single index", async () => {
    const adapter = new ConversationAdapter(makeMessages(3));
    await expect(adapter.read("99")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// read() — slice notation
// ---------------------------------------------------------------------------

describe("ConversationAdapter.read() — slice notation", () => {
  const messages = makeMessages(10);

  it("reads a half-open range", async () => {
    const adapter = new ConversationAdapter(messages);
    const parsed = JSON.parse(await adapter.read("3:7")) as Array<{ index: number }>;
    expect(parsed).toHaveLength(4);
    expect(parsed[0]!.index).toBe(3);
    expect(parsed[3]!.index).toBe(6);
  });

  it("reads from start when left side is empty", async () => {
    const adapter = new ConversationAdapter(messages);
    const parsed = JSON.parse(await adapter.read(":3")) as Array<{ index: number }>;
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.index).toBe(0);
    expect(parsed[2]!.index).toBe(2);
  });

  it("reads to end when right side is empty", async () => {
    const adapter = new ConversationAdapter(messages);
    const parsed = JSON.parse(await adapter.read("7:")) as Array<{ index: number }>;
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.index).toBe(7);
    expect(parsed[2]!.index).toBe(9);
  });

  it("clamps end beyond message count", async () => {
    const adapter = new ConversationAdapter(messages);
    const parsed = JSON.parse(await adapter.read("8:999")) as Array<{ index: number }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[parsed.length - 1]!.index).toBe(9);
  });

  it("throws for invalid address format", async () => {
    const adapter = new ConversationAdapter(messages);
    await expect(adapter.read("abc")).rejects.toThrow(/invalid/i);
    await expect(adapter.read("1:abc")).rejects.toThrow(/invalid/i);
  });

  it("throws when slice produces empty result", async () => {
    const adapter = new ConversationAdapter(messages);
    // Range past all messages — clamped to empty
    await expect(adapter.read("20:25")).rejects.toThrow();
  });
});
