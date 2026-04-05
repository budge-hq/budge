import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo } from "../src/index.ts";

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("derive", () => {
  test("merges derived values onto context", async () => {
    const { account } = polo.sourceSet(({ source }) => ({
      account: source(emptyInputSchema, {
        resolve: async () => ({ plan: "enterprise" as const }),
      }),
    }));

    const run = polo.window({
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
    const { user } = polo.sourceSet(({ source }) => ({
      user: source(emptyInputSchema, {
        resolve: async () => ({ name: "Alice" }),
      }),
    }));

    const run = polo.window({
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
    const { account } = polo.sourceSet(({ source }) => ({
      account: source(emptyInputSchema, {
        resolve: async () => ({ plan: "enterprise" as const }),
      }),
    }));

    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error derived keys cannot overwrite source keys
      polo.window({
        input: emptyInputSchema,
        id: "typecheck_derive_overlap",
        sources: { account },
        derive: () => ({ account: "shadowed" }),
      });
    }

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_derive_overlap",
      sources: { account },
      derive: (() => ({ account: "shadowed" })) as never,
    });

    await expect(run({})).rejects.toThrow(/cannot overwrite source key "account"/);
  });

  test("derived values cannot use the reserved raw key", async () => {
    const { account } = polo.sourceSet(({ source }) => ({
      account: source(emptyInputSchema, {
        resolve: async () => ({ plan: "enterprise" as const }),
      }),
    }));

    const typecheckOnly = Date.now() < 0;

    if (typecheckOnly) {
      // @ts-expect-error raw is reserved for template contexts
      polo.window({
        input: emptyInputSchema,
        id: "typecheck_derive_raw",
        sources: { account },
        derive: () => ({ raw: "shadowed" }),
      });
    }

    const run = polo.window({
      input: emptyInputSchema,
      id: "test_derive_raw",
      sources: { account },
      derive: (() => ({ raw: "shadowed" })) as never,
    });

    await expect(run({})).rejects.toThrow(/reserved context key "raw"/);
  });
});
