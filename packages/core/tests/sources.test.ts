import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo, registerSources } from "../src/index.ts";
import type { AnyResolverSource } from "../src/types.ts";

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("source inputs", () => {
  test("passes through a call-time input value", async () => {
    const task = polo.define(
      z.object({
        transcript: z.string(),
      }),
      {
        id: "test_input",
        sources: {
          transcript: polo.source.fromInput("transcript"),
        },
      },
    );

    const { context } = await polo.resolve(task, { transcript: "hello world" });
    expect(context.transcript).toBe("hello world");
  });

  test("respects tags option", () => {
    const src = polo.source.fromInput("transcript", { tags: ["phi"] });
    expect(src._tags).toEqual(["phi"]);
  });

  test("defaults tags to empty array", () => {
    const src = polo.source.fromInput("transcript");
    expect(src._tags).toEqual([]);
  });
});

describe("sources", () => {
  test("resolves async value", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_source",
      sources: {
        account: polo.source(emptyInputSchema, {
          async resolve() {
            return {
              plan: "enterprise" as const,
              tier: "priority" as const,
            };
          },
        }),
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(context.account).toEqual({ plan: "enterprise", tier: "priority" });
  });

  test("task input validation errors include schema details", async () => {
    const task = polo.define(
      z.object({
        accountId: z.string().min(2),
      }),
      {
        id: "test_task_input_validation",
        sources: {
          accountId: polo.source.fromInput("accountId"),
        },
      },
    );

    await expect(polo.resolve(task, { accountId: "x" })).rejects.toThrow(
      /Input validation failed for task "test_task_input_validation"/,
    );
  });

  test("source input validation errors include schema details", async () => {
    const strictInput = z.object({ accountId: z.string().min(4) });
    const task = polo.define(z.object({ accountId: z.string() }), {
      id: "test_source_input_validation",
      sources: {
        account: polo.source(strictInput, {
          async resolve() {
            return { ok: true };
          },
        }),
      },
    });

    await expect(polo.resolve(task, { accountId: "x" })).rejects.toThrow(
      /Source input validation failed:/,
    );
  });
});

describe("source sets", () => {
  test("rejects source handle reused under multiple keys", () => {
    const shared = polo.source(emptyInputSchema, {
      async resolve() {
        return { id: "p1" };
      },
    });

    expect(() =>
      polo.sourceSet(() => ({
        first: shared,
        second: shared,
      })),
    ).toThrowError(/reused under multiple keys/);
  });

  test("rejects source reused under a conflicting registered id", () => {
    const source = polo.source(emptyInputSchema, {
      async resolve() {
        return "ok";
      },
    });
    (source as AnyResolverSource)._registeredId = "existing";

    expect(() =>
      polo.sourceSet(() => ({
        next: source,
      })),
    ).toThrowError(/reused under multiple source ids/);
  });

  test("rejects dependencies that are missing an internal id", () => {
    const dependency = polo.source(emptyInputSchema, {
      async resolve() {
        return { id: "dep" };
      },
    });
    (dependency as AnyResolverSource)._internalId = undefined as unknown as string;

    expect(() =>
      polo.sourceSet((sources) => ({
        dependency,
        child: sources.value(
          emptyInputSchema,
          { dependency },
          {
            async resolve({ dependency }) {
              return { id: dependency.id };
            },
          },
        ),
      })),
    ).toThrowError(/references an unregistered dependency/);
  });

  test("rejects dependency aliases in sourceSet definitions", () => {
    const dependency = polo.source(emptyInputSchema, {
      async resolve() {
        return { id: "dep" };
      },
    });
    (dependency as AnyResolverSource)._registeredId = "account";

    expect(() =>
      polo.sourceSet((sources) => ({
        child: sources.value(
          emptyInputSchema,
          { customer: dependency },
          {
            async resolve({ customer }) {
              return { id: customer.id };
            },
          },
        ),
      })),
    ).toThrowError(/Dependency aliases are not supported yet/);
  });

  test("registerSources rejects non-sourceSet arguments", () => {
    expect(() => registerSources({ account: {} } as never)).toThrowError(/only accepts values/);
  });

  test("registerSources rejects duplicate keys across source sets", () => {
    const one = polo.sourceSet((sources) => ({
      account: sources.value(emptyInputSchema, {
        async resolve() {
          return { id: "one" };
        },
      }),
    }));
    const two = polo.sourceSet((sources) => ({
      account: sources.value(emptyInputSchema, {
        async resolve() {
          return { id: "two" };
        },
      }),
    }));

    expect(() => registerSources(one, two)).toThrowError(/Duplicate source key/);
  });
});
