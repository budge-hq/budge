import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

const budge = createBudge();
const emptyInputSchema = z.object({});

describe("derive", () => {
  test("merges derived values onto context", async () => {
    const { account } = budge.sourceSet(({ source }) => ({
      account: source.value(emptyInputSchema, {
        resolve: async () => ({ plan: "enterprise" as const }),
      }),
    }));

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_derive",
      sources: { account },
      derive: (ctx) => ({
        isEnterprise: ctx.account.plan === "enterprise",
      }),
    });

    const { context } = await run({});
    expect(context.isEnterprise).toBe(true);
  });

  test("derived values are available alongside source data", async () => {
    const { user } = budge.sourceSet(({ source }) => ({
      user: source.value(emptyInputSchema, {
        resolve: async () => ({ name: "Alice" }),
      }),
    }));

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_derive_coexist",
      sources: { user },
      derive: (ctx) => ({
        greeting: `Hello, ${ctx.user.name}`,
      }),
    });

    const { context } = await run({});
    expect(context.user?.name).toBe("Alice");
    expect(context.greeting).toBe("Hello, Alice");
  });

  test("derived values cannot overwrite source keys", async () => {
    const { account } = budge.sourceSet(({ source }) => ({
      account: source.value(emptyInputSchema, {
        resolve: async () => ({ plan: "enterprise" as const }),
      }),
    }));

    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error derived keys cannot overwrite source keys
      budge.window({
        input: emptyInputSchema,
        id: "typecheck_derive_overlap",
        sources: { account },
        derive: () => ({ account: "shadowed" }),
      });
    }

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_derive_overlap",
      sources: { account },
      derive: (() => ({ account: "shadowed" })) as never,
    });

    await expect(run({})).rejects.toThrow(/cannot overwrite source key "account"/);
  });

  test("derived values cannot use the reserved raw key", async () => {
    const { account } = budge.sourceSet(({ source }) => ({
      account: source.value(emptyInputSchema, {
        resolve: async () => ({ plan: "enterprise" as const }),
      }),
    }));

    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error raw is reserved for render contexts
      budge.window({
        input: emptyInputSchema,
        id: "typecheck_derive_raw",
        sources: { account },
        derive: () => ({ raw: "shadowed" }),
      });
    }

    const run = budge.window({
      input: emptyInputSchema,
      id: "test_derive_raw",
      sources: { account },
      derive: (() => ({ raw: "shadowed" })) as never,
    });

    await expect(run({})).rejects.toThrow(/reserved context key "raw"/);
  });
});
