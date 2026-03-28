import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { createPolo, RequiredSourceMissingError } from "../src/index.ts";

function expectType<T>(_value: T): void {
  // compile-time only
}

const polo = createPolo();
const emptyInputSchema = z.object({});

describe("policies.require", () => {
  test("throws when required source resolves to null", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_null",
      sources: {
        encounter: polo.source(emptyInputSchema, {
          resolve: async () => null,
        }),
      },
      policies: {
        require: ["encounter"],
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(RequiredSourceMissingError);
  });

  test("throws when required source resolves to undefined", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_undefined",
      sources: {
        encounter: polo.source(emptyInputSchema, {
          resolve: async () => undefined,
        }),
      },
      policies: {
        require: ["encounter"],
      },
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(RequiredSourceMissingError);
  });

  test("does not throw when required source has a value", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_ok",
      sources: {
        encounter: polo.source(emptyInputSchema, {
          resolve: async () => ({ id: "enc_1" }),
        }),
      },
      policies: {
        require: ["encounter"],
      },
    });

    const { context } = await polo.resolve(task, {});
    expectType<{ id: string }>(context.encounter);
    expect(context.encounter).toEqual({ id: "enc_1" });
  });
});

describe("policies.exclude", () => {
  test("excluded source is absent from context", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_exclude",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: ["aspirin"] }),
        }),
        priorNote: polo.source(emptyInputSchema, {
          resolve: async () => ({ text: "prior note" }),
        }),
      },
      derive: ({ context }) => ({
        includeIntake: !context.priorNote,
      }),
      policies: {
        exclude: [
          ({ context }) =>
            !context.includeIntake
              ? {
                  source: "intake",
                  reason: "follow-up visits exclude patient intake",
                }
              : false,
        ],
      },
    });

    const { context } = await polo.resolve(task, {});
    expect("intake" in context).toBe(false);
    expect(context.priorNote).toBeDefined();
  });

  test("source is present when exclude returns false", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_no_exclude",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: ["aspirin"] }),
        }),
        priorNote: polo.source(emptyInputSchema, {
          resolve: async () => null,
        }),
      },
      derive: ({ context }) => ({
        includeIntake: !context.priorNote,
      }),
      policies: {
        exclude: [
          ({ context }) =>
            !context.includeIntake
              ? {
                  source: "intake",
                  reason: "follow-up visits exclude patient intake",
                }
              : false,
        ],
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(context.intake).toEqual({ medications: ["aspirin"] });
  });

  test("exclude decision is recorded in trace", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_exclude_trace",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: [] }),
        }),
        priorNote: polo.source(emptyInputSchema, {
          resolve: async () => ({ text: "note" }),
        }),
      },
      derive: ({ context }) => ({
        includeIntake: !context.priorNote,
      }),
      policies: {
        exclude: [
          ({ context }) =>
            !context.includeIntake
              ? {
                  source: "intake",
                  reason: "follow-up visits exclude patient intake",
                }
              : false,
        ],
      },
    });

    const { trace } = await polo.resolve(task, {});
    const excluded = trace.policies.find((p) => p.action === "excluded");
    expect(excluded?.source).toBe("intake");
    expect(excluded?.reason).toBe("follow-up visits exclude patient intake");
  });

  test("required source cannot be excluded", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_require_exclude_conflict",
      sources: {
        intake: polo.source(emptyInputSchema, {
          resolve: async () => ({ medications: ["aspirin"] }),
        }),
      },
      policies: {
        require: ["intake"],
        exclude: [
          () => ({
            source: "intake",
            reason: "conflicting policy",
          }),
        ],
      } as never,
    });

    await expect(polo.resolve(task, {})).rejects.toThrow(/cannot be excluded/);
  });

  test("exclude callback runs once per resolution", async () => {
    let callCount = 0;

    const task = polo.define(emptyInputSchema, {
      id: "test_exclude_called_once",
      sources: {
        sourceA: polo.source(emptyInputSchema, {
          resolve: async () => "a",
        }),
        sourceB: polo.source(emptyInputSchema, {
          resolve: async () => "b",
        }),
      },
      policies: {
        exclude: [
          () => {
            callCount++;
            return false;
          },
        ],
      },
    });

    await polo.resolve(task, {});
    expect(callCount).toBe(1);
  });

  test("exclude callback that would throw on second call does not throw", async () => {
    let callCount = 0;

    const task = polo.define(emptyInputSchema, {
      id: "test_exclude_no_second_call",
      sources: {
        sourceA: polo.source(emptyInputSchema, {
          resolve: async () => "a",
        }),
        sourceB: polo.source(emptyInputSchema, {
          resolve: async () => "b",
        }),
      },
      policies: {
        exclude: [
          () => {
            callCount++;
            if (callCount === 1) {
              return {
                source: "sourceA" as const,
                reason: "excluded once",
              };
            }

            throw new Error("Error on second call");
          },
        ],
      },
    });

    const { context } = await polo.resolve(task, {});
    expect(callCount).toBe(1);
    expect("sourceA" in context).toBe(false);
    expect(context.sourceB).toBe("b");
  });

  test("excluded chunk source keeps redacted exclusion records in trace", async () => {
    const task = polo.define(emptyInputSchema, {
      id: "test_excluded_chunk_trace_records",
      sources: {
        docs: polo.source.chunks(emptyInputSchema, {
          async resolve() {
            return [
              { content: "chunk A secret", score: 0.9 },
              { content: "chunk B secret", score: 0.7 },
            ];
          },
        }),
      },
      policies: {
        exclude: [
          () => ({
            source: "docs",
            reason: "excluded for test",
          }),
        ],
      },
    });

    const { context, trace } = await polo.resolve(task, {});

    expect("docs" in context).toBe(false);

    const docsRecord = trace.sources.find((source) => source.key === "docs");
    expect(docsRecord?.type).toBe("chunks");
    if (docsRecord?.type === "chunks") {
      expect(docsRecord.chunks).toHaveLength(2);
      expect(docsRecord.chunks.every((chunk) => chunk.included === false)).toBe(true);
      expect(docsRecord.chunks.every((chunk) => chunk.reason === "excluded")).toBe(true);
      expect(docsRecord.chunks.every((chunk) => chunk.content === "")).toBe(true);
    }

    expect(JSON.stringify(trace)).not.toContain("chunk A secret");
    expect(JSON.stringify(trace)).not.toContain("chunk B secret");
  });
});
