import stringify from "safe-stable-stringify";
import { estimateTokenCount } from "tokenx";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";
import { resolveWindowSpec } from "../src/resolve.ts";
import { createWindowSpec } from "../src/window-spec.ts";

const mockTokenizer = {
  estimate(text: string): number {
    return text.length;
  },
};

function getTrace(
  result: Awaited<ReturnType<ReturnType<typeof createBudge>["window"]>["resolve"]>,
  key: string,
) {
  const trace = result.traces.sources.find((source) => source.key === key);

  expect(trace).toBeDefined();

  return trace!;
}

describe("token estimation", () => {
  test("contentLength is populated for a value source when tokenizer is configured", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });
    const record = {
      id: "enc_123",
      status: "ready",
    };

    const window = budge.window({
      id: "value-content-length-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return record;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");

    expect(trace.contentLength).toBe(stringify(record)?.length);
  });

  test("estimatedTokens is populated for a value source when tokenizer is configured", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });
    const record = {
      id: "enc_123",
      status: "ready",
    };

    const window = budge.window({
      id: "value-estimated-tokens-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return record;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");

    expect(trace.estimatedTokens).toBe(stringify(record)?.length);
  });

  test("contentLength is populated for a value source even when no tokenizer is configured", async () => {
    const budge = createBudge();
    const schema = z.object({});
    const record = {
      id: "enc_123",
      status: "ready",
    };
    const windowSpec = createWindowSpec(schema, {
      id: "value-no-tokenizer-window",
      sources: {
        record: budge.source.value(schema, {
          async resolve() {
            return record;
          },
        }),
      },
    });

    const result = await resolveWindowSpec(windowSpec, { input: {} }, undefined);
    const trace = getTrace(result, "record");

    expect(trace.contentLength).toBe(stringify(record)?.length);
    expect(trace.estimatedTokens).toBeUndefined();
  });

  test("estimatedTokens uses tokenx as fallback when no tokenizer is configured", async () => {
    const budge = createBudge();
    const record = {
      id: "enc_123",
      status: "ready",
    };

    const window = budge.window({
      id: "value-tokenx-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return record;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");
    const serialized = stringify(record);

    expect(trace.estimatedTokens).toBe(estimateTokenCount(serialized));
  });

  test("contentLength uses content-joined serialization for rag sources", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });
    const chunks = [{ content: "Alpha" }, { content: "Beta" }];

    const window = budge.window({
      id: "rag-content-length-window",
      input: z.object({}),
      sources: ({ source }) => ({
        docs: source.rag(z.object({}), {
          async resolve() {
            return chunks;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "docs");

    expect(trace.contentLength).toBe("Alpha\nBeta".length);
  });

  test("contentLength uses content-joined serialization for history sources", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });

    const window = budge.window({
      id: "history-content-length-window",
      input: z.object({}),
      sources: ({ source }) => ({
        history: source.history(z.object({}), {
          async resolve() {
            return [
              { id: "m1", role: "user", content: "Alpha" },
              { id: "m2", role: "assistant", content: "Ignore me", kind: "reasoning" },
              { id: "m3", role: "assistant", content: "Beta" },
            ];
          },
          filter: {
            excludeKinds: ["reasoning"],
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "history");

    expect(trace.contentLength).toBe("Alpha\nBeta".length);
  });

  test("contentLength uses safe-stable-stringify on Object.values for tools sources", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });

    const window = budge.window({
      id: "tools-content-length-window",
      input: z.object({}),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Search docs",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
              },
            },
            getWeather: {
              description: "Get weather",
              inputSchema: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
              },
            },
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "tools");

    expect(trace.contentLength).toBe(stringify(Object.values(result.context.tools))?.length);
  });

  test("tokenizer throwing does not break resolution - context and traces still returned", async () => {
    const budge = createBudge({
      tokenizer: {
        estimate() {
          throw new Error("tokenizer failed");
        },
      },
    });

    const window = budge.window({
      id: "tokenizer-throw-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return {
              id: "enc_123",
              status: "ready",
            };
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });

    expect(result.context.record).toEqual({
      id: "enc_123",
      status: "ready",
    });
    expect(result.traces.sources).toHaveLength(1);
  });

  test("tokenizer throwing leaves estimatedTokens undefined but contentLength still populated", async () => {
    const budge = createBudge({
      tokenizer: {
        estimate() {
          throw new Error("tokenizer failed");
        },
      },
    });
    const record = {
      id: "enc_123",
      status: "ready",
    };

    const window = budge.window({
      id: "tokenizer-throw-fields-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return record;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");

    expect(trace.estimatedTokens).toBeUndefined();
    expect(trace.contentLength).toBe(stringify(record)?.length);
  });

  test("contentLength is populated for input sources (fromInput)", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });

    const window = budge.window({
      id: "input-content-length-window",
      input: z.object({
        transcript: z.string(),
      }),
      sources: ({ source }) => ({
        transcript: source.fromInput("transcript"),
      }),
    });

    const result = await window.resolve({
      input: {
        transcript: "hello world",
      },
    });
    const trace = getTrace(result, "transcript");

    expect(trace.contentLength).toBe(stringify("hello world")?.length);
  });

  test("all sources in a multi-source window get contentLength populated", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });

    const window = budge.window({
      id: "multi-source-content-length-window",
      input: z.object({
        transcript: z.string(),
      }),
      sources: ({ source }) => ({
        transcript: source.fromInput("transcript"),
        record: source.value(z.object({ transcript: z.string() }), {
          async resolve({ input }) {
            return {
              transcript: input.transcript,
            };
          },
        }),
        docs: source.rag(z.object({}), {
          async resolve() {
            return [{ content: "Doc" }];
          },
        }),
        history: source.history(z.object({}), {
          async resolve() {
            return [{ id: "m1", role: "user", content: "History" }];
          },
        }),
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Search docs",
              inputSchema: { type: "object" },
            },
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        transcript: "hello world",
      },
    });

    for (const trace of result.traces.sources) {
      expect(trace.contentLength).toBeDefined();
    }
  });

  test("estimatedTokens reflects the tokenizer's return value accurately", async () => {
    const budge = createBudge({
      tokenizer: {
        estimate(text: string) {
          return text.length + 7;
        },
      },
    });
    const record = {
      id: "enc_123",
      status: "ready",
    };

    const window = budge.window({
      id: "estimated-tokens-accuracy-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return record;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");

    expect(trace.estimatedTokens).toBe((stringify(record)?.length ?? 0) + 7);
  });

  test("circular reference in a value source does not throw - contentLength is populated", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });
    const circular: { id: string; self?: unknown } = {
      id: "enc_123",
    };

    circular.self = circular;

    const window = budge.window({
      id: "circular-value-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return circular;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");

    expect(result.context.record).toBe(circular);
    expect(trace.contentLength).toBe(stringify(circular)?.length);
  });

  test("safe-stable-stringify on undefined value source result - contentLength handles it", async () => {
    const budge = createBudge({ tokenizer: mockTokenizer });

    const window = budge.window({
      id: "undefined-value-window",
      input: z.object({}),
      sources: ({ source }) => ({
        record: source.value(z.object({}), {
          async resolve() {
            return undefined;
          },
        }),
      }),
    });

    const result = await window.resolve({ input: {} });
    const trace = getTrace(result, "record");

    expect(result.context.record).toBeUndefined();
    expect(trace.contentLength).toBeUndefined();
    expect(trace.estimatedTokens).toBeUndefined();
  });
});
