import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo } from "../src/index.ts";
import type { AnyResolverSource } from "../src/types.ts";

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("source inputs", () => {
  test("passes through a call-time input value", async () => {
    const run = polo.window({
      input: z.object({
        transcript: z.string(),
      }),
      id: "test_input",
      sources: {
        transcript: polo.input("transcript"),
      },
    });

    const { context } = await run({ transcript: "hello world" });
    expect(context.transcript).toBe("hello world");
  });

  test("respects tags option", () => {
    const transcript = polo.input("transcript", { tags: ["phi"] });
    expect(transcript._tags).toEqual(["phi"]);
  });

  test("defaults tags to empty array", () => {
    const transcript = polo.input("transcript");
    expect(transcript._tags).toEqual([]);
  });
});

describe("sources", () => {
  test("window id must be present", () => {
    expect(() =>
      polo.window({
        input: emptyInputSchema,
        sources: {
          ...polo.sourceSet(({ source }) => ({
            account: source.value(emptyInputSchema, {
              async resolve() {
                return { ok: true };
              },
            }),
          })),
        },
      } as never),
    ).toThrow(/non-empty string id/);
  });

  test("window id must be a non-empty string", () => {
    expect(() =>
      polo.window({
        input: emptyInputSchema,
        id: "   ",
        sources: {
          ...polo.sourceSet(({ source }) => ({
            account: source.value(emptyInputSchema, {
              async resolve() {
                return { ok: true };
              },
            }),
          })),
        },
      }),
    ).toThrow(/non-empty string id/);
  });

  test("resolves async value", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_source",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            async resolve() {
              return {
                plan: "enterprise" as const,
                tier: "priority" as const,
              };
            },
          }),
        })),
      },
    });

    const { context } = await run({});
    expect(context.account).toEqual({ plan: "enterprise", tier: "priority" });
  });

  test("task input validation errors include schema details", async () => {
    const run = polo.window({
      input: z.object({
        accountId: z.string().min(2),
      }),
      id: "test_task_input_validation",
      sources: {
        accountId: polo.input("accountId"),
      },
    });

    await expect(run({ accountId: "x" })).rejects.toThrow(
      /Input validation failed for context window "test_task_input_validation"/,
    );
  });

  test("source input validation errors include schema details", async () => {
    const strictInput = z.object({ accountId: z.string().min(4) });
    const run = polo.window({
      input: z.object({ accountId: z.string() }),
      id: "test_source_input_validation",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source.value(strictInput, {
            async resolve() {
              return { ok: true };
            },
          }),
        })),
      },
    });

    await expect(run({ accountId: "x" })).rejects.toThrow(/Source input validation failed:/);
  });

  test("source output validation errors include schema details", async () => {
    const run = polo.window({
      input: emptyInputSchema,
      id: "test_source_output_validation",
      sources: {
        ...polo.sourceSet(({ source }) => ({
          account: source.value(emptyInputSchema, {
            output: z.object({ id: z.string() }),
            async resolve() {
              return { id: 123 };
            },
          }),
        })),
      },
    });

    await expect(run({})).rejects.toThrow(/Source output validation failed:/);
  });

  test("window reserves raw as a context key", () => {
    expect(() =>
      polo.window({
        input: z.object({ raw: z.string() }),
        id: "test_reserved_raw_source_key",
        sources: {
          raw: polo.input("raw"),
        },
      } as never),
    ).toThrow(/reserves "raw" as a context key/);
  });
});

describe("source sets", () => {
  test("rejects source handle reused under multiple keys", () => {
    expect(() =>
      polo.sourceSet(({ source }) => {
        const shared = source.value(emptyInputSchema, {
          async resolve() {
            return { id: "p1" };
          },
        });

        return { first: shared, second: shared };
      }),
    ).toThrowError(/reused under multiple keys/);
  });

  test("rejects input handles inside sourceSet", () => {
    expect(() =>
      polo.sourceSet(() => ({
        transcript: polo.input("transcript") as never,
      })),
    ).toThrowError(/only accepts resolver or rag sources/);
  });

  test("rejects source reused under a conflicting registered id", () => {
    expect(() =>
      polo.sourceSet(({ source }) => {
        const s = source.value(emptyInputSchema, {
          async resolve() {
            return "ok";
          },
        });

        (s as AnyResolverSource)._registeredId = "existing";
        return { next: s };
      }),
    ).toThrowError(/reused under multiple source ids/);
  });

  test("rejects dependencies that are missing an internal id", () => {
    expect(() =>
      polo.sourceSet(({ source }) => {
        const dep = source.value(emptyInputSchema, {
          async resolve() {
            return { id: "dep" };
          },
        });

        (dep as AnyResolverSource)._internalId = undefined as unknown as string;
        return {
          dependency: dep,
          child: source.value(
            emptyInputSchema,
            { dependency: dep },
            {
              async resolve({ dependency: d }) {
                return { id: d.id };
              },
            },
          ),
        };
      }),
    ).toThrowError(/references an unregistered dependency/);
  });

  test("supports dependency aliases in sourceSet definitions", async () => {
    const { account, child } = polo.sourceSet(({ source }) => {
      const dependency = source.value(emptyInputSchema, {
        async resolve() {
          return { id: "dep" };
        },
      });

      return {
        account: dependency,
        child: source.value(
          emptyInputSchema,
          { customer: dependency },
          {
            async resolve({ customer }) {
              return { id: customer.id };
            },
          },
        ),
      };
    });

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_dependency_aliases",
      sources: { account, child },
    });

    const { context } = await run({});
    expect(context.child).toEqual({ id: "dep" });
  });

  test("polo.sources rejects non-sourceSet arguments", () => {
    expect(() => polo.sources({ account: {} } as never)).toThrowError(/only accepts values/);
  });

  test("polo.sources rejects duplicate keys across source sets", () => {
    const one = polo.sourceSet(({ source }) => ({
      account: source.value(emptyInputSchema, {
        async resolve() {
          return { id: "one" };
        },
      }),
    }));
    const two = polo.sourceSet(({ source }) => ({
      account: source.value(emptyInputSchema, {
        async resolve() {
          return { id: "two" };
        },
      }),
    }));

    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error duplicate source keys are rejected statically
      polo.sources(one, two);
    }

    expect(() => polo.sources(...([one, two] as never))).toThrowError(/Duplicate source key/);
  });
});
