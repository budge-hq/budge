import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  CircularSourceDependencyError,
  MissingSourceDependencyError,
  createBudge,
  type ResolverSource,
} from "../src/index.ts";

const budge = createBudge();
const emptyInputSchema = z.object({});

describe("source graph", () => {
  test("throws when a selected source depends on an unselected source", () => {
    const account = budge.source.value(
      z.object({
        accountId: z.string(),
      }),
      {
        async resolve({ input }) {
          return { id: input.accountId };
        },
      },
    );

    expect(() =>
      budge.window({
        id: "missing-dependency",
        input: z.object({
          accountId: z.string(),
        }),
        sources: ({ source }) => {
          const priorNote = source.value(
            z.object({}),
            { account },
            {
              async resolve({ account }) {
                return `Prior note for ${account.id}`;
              },
            },
          );

          return { priorNote };
        },
      }),
    ).toThrowError(MissingSourceDependencyError);
  });

  test("throws when the source graph contains a cycle", () => {
    const first = budge.source.value(emptyInputSchema, {
      async resolve() {
        return "first";
      },
    });
    const second = budge.source.value(emptyInputSchema, {
      async resolve() {
        return "second";
      },
    });

    (first as ResolverSource<unknown>)._dependencySources = { second };
    (second as ResolverSource<unknown>)._dependencySources = { first };

    expect(() =>
      budge.window({
        id: "cyclic-window",
        input: emptyInputSchema,
        sources: () => ({ first, second }),
      }),
    ).toThrowError(CircularSourceDependencyError);
  });

  test("resolves independent sources in parallel waves", async () => {
    const started: string[] = [];

    const window = budge.window({
      id: "parallel-window",
      input: emptyInputSchema,
      sources: ({ source }) => ({
        first: source.value(emptyInputSchema, {
          async resolve() {
            started.push("first");
            await new Promise((resolve) => setTimeout(resolve, 10));
            return "first-value";
          },
        }),
        second: source.value(emptyInputSchema, {
          async resolve() {
            started.push("second");
            await new Promise((resolve) => setTimeout(resolve, 10));
            return "second-value";
          },
        }),
      }),
    });

    const startedAt = Date.now();
    const result = await window.resolve({ input: {} });
    const durationMs = Date.now() - startedAt;

    expect(started).toContain("first");
    expect(started).toContain("second");
    expect(result.context.first).toBe("first-value");
    expect(result.context.second).toBe("second-value");
    expect(durationMs).toBeLessThan(18);
  });

  test("throws AggregateError when multiple sources fail in the same wave", async () => {
    const window = budge.window({
      id: "aggregate-failure-window",
      input: emptyInputSchema,
      sources: ({ source }) => ({
        first: source.value(emptyInputSchema, {
          async resolve() {
            throw new Error("first failure");
          },
        }),
        second: source.value(emptyInputSchema, {
          async resolve() {
            throw new Error("second failure");
          },
        }),
      }),
    });

    try {
      await window.resolve({ input: {} });
      throw new Error("Expected window.resolve() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);

      const aggregateError = error as AggregateError & {
        traces?: {
          sources: Array<{ key: string; status: string }>;
        };
      };

      expect(aggregateError.errors).toHaveLength(2);
      expect(aggregateError.errors.map((failure) => (failure as Error).message).sort()).toEqual([
        'Source "first" threw during resolution in context window "aggregate-failure-window": Error: first failure',
        'Source "second" threw during resolution in context window "aggregate-failure-window": Error: second failure',
      ]);
      expect(
        aggregateError.traces?.sources
          .filter((source) => source.status === "failed")
          .map((source) => source.key)
          .sort(),
      ).toEqual(["first", "second"]);
    }
  });
});
