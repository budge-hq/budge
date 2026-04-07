import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";

function expectType<T>(_value: T): void {
  // compile-time only
}

describe("window resolution", () => {
  test("resolves reusable sources through a declarative source builder", async () => {
    const budge = createBudge();

    const accountSource = budge.source.value(
      z.object({
        accountId: z.string(),
      }),
      {
        tags: ["internal"],
        async resolve({ input }) {
          return {
            id: input.accountId,
            name: "Acme",
            plan: "enterprise" as const,
          };
        },
      },
    );

    const priorNoteSource = budge.source.value(
      z.object({}),
      { account: accountSource },
      {
        async resolve({ account }) {
          return `Prior note for ${account.name}`;
        },
      },
    );

    const window = budge.window({
      id: "support-note",
      input: z.object({
        accountId: z.string(),
        transcript: z.string(),
      }),
      sources: ({ source }) => ({
        transcript: source.fromInput("transcript", { tags: ["restricted"] }),
        account: accountSource,
        priorNote: priorNoteSource,
      }),
    });

    const result = await window.resolve({
      input: {
        accountId: "acc_123",
        transcript: "Our webhook deliveries are timing out.",
      },
    });

    expectType<string>(result.context.transcript);
    expectType<{ id: string; name: string; plan: "enterprise" }>(result.context.account);
    expectType<string>(result.context.priorNote);

    expect(result.context.transcript).toBe("Our webhook deliveries are timing out.");
    expect(result.context.account.name).toBe("Acme");
    expect(result.context.priorNote).toBe("Prior note for Acme");
    expect(result.traces.windowId).toBe("support-note");
    expect(result.traces.sources).toHaveLength(3);

    const transcriptTrace = result.traces.sources.find((source) => source.key === "transcript");
    expect(transcriptTrace?.kind).toBe("input");
    expect(transcriptTrace?.tags).toEqual(["restricted"]);

    const priorNoteTrace = result.traces.sources.find((source) => source.key === "priorNote");
    expect(priorNoteTrace?.dependsOn).toEqual(["account"]);
  });
});
