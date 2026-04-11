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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

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
    ).toThrow(MissingSourceDependencyError);
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
    ).toThrow(CircularSourceDependencyError);
  });

  test("resolves independent sources in parallel waves", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const firstGate = createDeferred();
    const secondGate = createDeferred();

    const window = budge.window({
      id: "parallel-window",
      input: emptyInputSchema,
      sources: ({ source }) => ({
        first: source.value(emptyInputSchema, {
          async resolve() {
            firstStarted.resolve();
            await firstGate.promise;
            return "first-value";
          },
        }),
        second: source.value(emptyInputSchema, {
          async resolve() {
            secondStarted.resolve();
            await secondGate.promise;
            return "second-value";
          },
        }),
      }),
    });

    const resolving = window.resolve({ input: {} });

    await firstStarted.promise;
    await secondStarted.promise;

    firstGate.resolve();
    secondGate.resolve();

    const result = await resolving;

    expect(result.context.first).toBe("first-value");
    expect(result.context.second).toBe("second-value");
  });

  test("waits for one wave to finish before starting dependent sources", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const thirdStarted = createDeferred();
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    let didThirdStart = false;

    const first = budge.source.value(emptyInputSchema, {
      async resolve() {
        firstStarted.resolve();
        await firstGate.promise;
        return "first-value";
      },
    });

    const second = budge.source.value(emptyInputSchema, {
      async resolve() {
        secondStarted.resolve();
        await secondGate.promise;
        return "second-value";
      },
    });

    const window = budge.window({
      id: "dependent-wave-window",
      input: emptyInputSchema,
      sources: ({ source }) => ({
        first,
        second,
        third: source.value(
          emptyInputSchema,
          { first, second },
          {
            async resolve({ first, second }) {
              didThirdStart = true;
              thirdStarted.resolve();
              return `${first}:${second}`;
            },
          },
        ),
      }),
    });

    const resolving = window.resolve({ input: {} });

    await firstStarted.promise;
    await secondStarted.promise;

    expect(didThirdStart).toBe(false);

    firstGate.resolve();
    secondGate.resolve();

    await thirdStarted.promise;

    const result = await resolving;

    expect(result.context.first).toBe("first-value");
    expect(result.context.second).toBe("second-value");
    expect(result.context.third).toBe("first-value:second-value");
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
      expect(
        aggregateError.errors
          .map((failure) => (failure as Error).message)
          .sort(),
      ).toEqual([
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
