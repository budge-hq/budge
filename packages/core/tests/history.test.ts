import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";
import type { Message } from "../src/index.ts";

function expectType<T>(_value: T): void {
  // compile-time only
}

function createTextMessages(ids: string[]): Message[] {
  return ids.map((id) => ({
    id,
    role: "user",
    content: id,
  }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for condition.");
}

describe("history sources", () => {
  test("resolves messages and returns Message[] in context", async () => {
    const budge = createBudge();
    const messages = createTextMessages(["m1", "m2"]);

    const window = budge.window({
      id: "history-window",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve({ input }) {
            expect(input.threadId).toBe("thread_123");
            return messages;
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expectType<Message[]>(result.context.history);
    expect(result.context.history).toEqual(messages);
  });

  test("sliding window keeps the last N messages", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-sliding-window",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return createTextMessages(["m1", "m2", "m3", "m4", "m5"]);
          },
          compaction: {
            strategy: "sliding",
            maxMessages: 3,
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.context.history.map((message) => message.id)).toEqual(["m3", "m4", "m5"]);
  });

  test("drops oldest messages first under sliding window", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-sliding-oldest-first",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return createTextMessages(["m1", "m2", "m3", "m4"]);
          },
          compaction: {
            strategy: "sliding",
            maxMessages: 2,
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.context.history.map((message) => message.id)).toEqual(["m3", "m4"]);
  });

  test("filter strips messages matching excludeKinds before compaction", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-filter-window",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return [
              { id: "m1", role: "user", content: "hello" },
              { id: "m2", role: "assistant", content: "thinking", kind: "reasoning" },
              { id: "m3", role: "assistant", content: "reply" },
              { id: "m4", role: "assistant", content: "call tool", kind: "tool_call" },
            ];
          },
          filter: {
            excludeKinds: ["tool_call", "reasoning"],
          },
          compaction: {
            strategy: "sliding",
            maxMessages: 10,
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.context.history.map((message) => message.id)).toEqual(["m1", "m3"]);
  });

  test("droppedByKind counts are accurate per kind", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-dropped-by-kind",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return [
              { id: "m1", role: "tool", content: "tool output" },
              { id: "m2", role: "assistant", content: "chain of thought", kind: "reasoning" },
              { id: "m3", role: "assistant", content: "more thought", kind: "reasoning" },
              { id: "m4", role: "tool", content: "tool output 2", kind: "tool_result" },
              { id: "m5", role: "user", content: "keep me" },
            ];
          },
          filter: {
            excludeKinds: ["tool_result", "reasoning"],
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "history");

    expect(trace?.droppedByKind).toEqual({
      reasoning: 2,
      tool_result: 2,
    });
  });

  test("filter runs before compaction", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-filter-before-compaction",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return [
              { id: "m1", role: "user", content: "keep 1" },
              { id: "m2", role: "assistant", content: "drop me", kind: "reasoning" },
              { id: "m3", role: "assistant", content: "keep 2" },
              { id: "m4", role: "user", content: "keep 3" },
            ];
          },
          filter: {
            excludeKinds: ["reasoning"],
          },
          compaction: {
            strategy: "sliding",
            maxMessages: 3,
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.context.history.map((message) => message.id)).toEqual(["m1", "m3", "m4"]);
  });

  test("trace has kind === history", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-trace-kind",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return createTextMessages(["m1"]);
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.traces.sources[0]?.kind).toBe("history");
  });

  test("trace carries totalMessages, includedMessages, droppedMessages, droppedByKind, strategy, and maxMessages", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-trace-fields",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return [
              { id: "m1", role: "user", content: "keep 1" },
              { id: "m2", role: "assistant", content: "drop", kind: "reasoning" },
              { id: "m3", role: "assistant", content: "keep 2" },
              { id: "m4", role: "user", content: "keep 3" },
              { id: "m5", role: "assistant", content: "keep 4" },
            ];
          },
          filter: {
            excludeKinds: ["reasoning"],
          },
          compaction: {
            strategy: "sliding",
            maxMessages: 2,
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "history");

    expect(trace).toMatchObject({
      kind: "history",
      totalMessages: 5,
      includedMessages: 2,
      droppedMessages: 3,
      droppedByKind: {
        reasoning: 1,
      },
      strategy: "sliding",
      maxMessages: 2,
    });
  });

  test("history source works alongside value and rag sources in the same window and resolves in parallel", async () => {
    const budge = createBudge();
    const started: string[] = [];

    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const accountSource = budge.source.value(z.object({ threadId: z.string() }), {
      async resolve({ input }) {
        started.push("value");
        await gate;
        return { id: input.threadId };
      },
    });

    const docsSource = budge.source.rag(z.object({ threadId: z.string() }), {
      async resolve() {
        started.push("rag");
        await gate;
        return [{ content: "Relevant doc", score: 0.9 }];
      },
    });

    const window = budge.window({
      id: "history-parallel-window",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve({ input }) {
            started.push("history");
            await gate;
            return [{ id: input.threadId, role: "user", content: "hello" }];
          },
        }),
        account: accountSource,
        docs: docsSource,
      }),
    });

    const pending = window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    await waitFor(() => started.length === 3);

    releaseGate?.();

    const result = await pending;

    expect(new Set(started)).toEqual(new Set(["history", "value", "rag"]));
    expect(result.context.history).toHaveLength(1);
    expect(result.context.account).toEqual({ id: "thread_123" });
    expect(result.context.docs[0]?.content).toBe("Relevant doc");
  });

  test("message without explicit kind infers kind from role", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-kind-inference",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return [
              { id: "m1", role: "tool", content: "tool output" },
              { id: "m2", role: "user", content: "plain text" },
            ];
          },
          filter: {
            excludeKinds: ["tool_result"],
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "history");

    expect(result.context.history.map((message) => message.id)).toEqual(["m2"]);
    expect(trace?.droppedByKind).toEqual({ tool_result: 1 });
  });

  test("missing id on a message does not throw", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "history-runtime-leniency",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve() {
            return [{ role: "assistant", content: "hello" } as unknown as Message];
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.context.history).toHaveLength(1);
    expect(result.context.history[0]).toEqual({ role: "assistant", content: "hello" });
  });
});
