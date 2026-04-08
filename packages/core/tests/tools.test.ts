import { describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createBudge } from "../src/index.ts";
import type { MCPClientLike, ToolDefinition } from "../src/index.ts";

function expectType<T>(_value: T): void {
  // compile-time only
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

describe("tools sources", () => {
  test("resolves static tools into a Record<string, ToolDefinition>", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "tools-static-window",
      input: z.object({
        threadId: z.string(),
      }),
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
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expectType<Record<string, ToolDefinition>>(result.context.tools);
    expect(result.context.tools).toEqual({
      searchDocs: {
        name: "searchDocs",
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    });
  });

  test("resolves MCP tools by calling client.tools() and merging into record", async () => {
    const budge = createBudge();
    const tools = vi.fn(async () => ({
      searchDocs: {
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
      ping: {
        description: "Ping remote server",
      },
    }));
    const client: MCPClientLike = { tools };

    const resolved = await budge.source.tools({ mcp: client }).resolve({});

    expect(tools).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      searchDocs: {
        name: "searchDocs",
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
      ping: {
        name: "ping",
        description: "Ping remote server",
        inputSchema: {},
      },
    });
  });

  test("accepts array of MCP clients and merges all tools", async () => {
    const budge = createBudge();
    const firstClient: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "Search docs",
            inputSchema: { type: "object" },
          },
        };
      },
    };
    const secondClient: MCPClientLike = {
      async tools() {
        return {
          getWeather: {
            description: "Get weather",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const resolved = await budge.source.tools({ mcp: [firstClient, secondClient] }).resolve({});

    expect(resolved).toEqual({
      searchDocs: {
        name: "searchDocs",
        description: "Search docs",
        inputSchema: { type: "object" },
      },
      getWeather: {
        name: "getWeather",
        description: "Get weather",
        inputSchema: { type: "object" },
      },
    });
  });

  test("MCP tools win on name collision with static tools and later writers win", async () => {
    const budge = createBudge();
    const firstClient: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "First MCP version",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        };
      },
    };
    const secondClient: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "Second MCP version",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        };
      },
    };

    const resolved = await budge.source
      .tools({
        tools: {
          searchDocs: {
            description: "Static version",
            inputSchema: { type: "object", properties: { term: { type: "string" } } },
          },
        },
        mcp: [firstClient, secondClient],
      })
      .resolve({});

    expect(resolved.searchDocs).toEqual({
      name: "searchDocs",
      description: "Second MCP version",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
  });

  test("normalize function is applied to each raw tool entry and keys by normalized name", async () => {
    const budge = createBudge();
    const normalizeCalls: Array<{ name: string; raw: Record<string, unknown> }> = [];
    const client: MCPClientLike = {
      async tools() {
        return {
          remote_lookup: {
            description: "Remote lookup",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const resolved = await budge.source
      .tools({
        tools: {
          local_lookup: {
            description: "Local lookup",
            inputSchema: { type: "object" },
          },
          local_search: {
            description: "Local search",
            inputSchema: { type: "object", title: "last one wins" },
          },
        },
        mcp: client,
        normalize(name, raw) {
          normalizeCalls.push({ name, raw });
          return {
            name: name.includes("lookup") ? "searchDocs" : "remoteSearch",
            description: typeof raw.description === "string" ? raw.description : undefined,
            inputSchema:
              typeof raw.inputSchema === "object" && raw.inputSchema !== null
                ? (raw.inputSchema as Record<string, unknown>)
                : {},
          };
        },
      })
      .resolve({});

    expect(normalizeCalls.map(({ name }) => name).sort()).toEqual([
      "local_lookup",
      "local_search",
      "remote_lookup",
    ]);
    expect(Object.keys(resolved).sort()).toEqual(["remoteSearch", "searchDocs"]);
    expect(resolved.searchDocs).toEqual({
      name: "searchDocs",
      description: "Remote lookup",
      inputSchema: { type: "object" },
    });
    expect(resolved.remoteSearch).toEqual({
      name: "remoteSearch",
      description: "Local search",
      inputSchema: { type: "object", title: "last one wins" },
    });
  });

  test("normalize receives the full raw MCP payload including extra fields", async () => {
    const budge = createBudge();
    const seenAnnotations: unknown[] = [];
    const client: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "Search docs",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          } as Record<string, unknown> as {
            description?: string;
            inputSchema?: Record<string, unknown>;
          },
        };
      },
    };

    await budge.source
      .tools({
        mcp: client,
        normalize(name, raw) {
          seenAnnotations.push(raw.annotations);
          return {
            name,
            description: typeof raw.description === "string" ? raw.description : undefined,
            inputSchema:
              typeof raw.inputSchema === "object" && raw.inputSchema !== null
                ? (raw.inputSchema as Record<string, unknown>)
                : {},
          };
        },
      })
      .resolve({});

    expect(seenAnnotations).toEqual([{ readOnlyHint: true }]);
  });

  test("trace has kind === tools", async () => {
    const budge = createBudge();

    const window = budge.window({
      id: "tools-trace-kind",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              inputSchema: { type: "object" },
            },
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.traces.sources[0]?.kind).toBe("tools");
  });

  test("trace carries raw totalTools before merge plus includedTools, droppedTools, toolNames, and toolSources", async () => {
    const budge = createBudge();
    const client: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "Remote search",
            inputSchema: { type: "object" },
          },
          getWeather: {
            description: "Weather",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const window = budge.window({
      id: "tools-trace-fields",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Static search",
              inputSchema: { type: "object" },
            },
            summarize: {
              description: "Summarize",
              inputSchema: { type: "object" },
            },
          },
          mcp: client,
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "tools");

    expect(trace?.kind).toBe("tools");
    expect(trace?.totalTools).toBe(4);
    expect(trace?.includedTools).toBe(3);
    expect(trace?.droppedTools).toBe(1);
    expect([...(trace?.toolNames ?? [])].sort()).toEqual(["getWeather", "searchDocs", "summarize"]);
    expect([...(trace?.toolSources.static ?? [])].sort()).toEqual(["summarize"]);
    expect([...(trace?.toolSources.mcp ?? [])].sort()).toEqual(["getWeather", "searchDocs"]);
  });

  test("single static and MCP name collision reports droppedTools and toolCollisions", async () => {
    const budge = createBudge();
    const client: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "Remote search",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const window = budge.window({
      id: "tools-trace-single-collision",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Static search",
              inputSchema: { type: "object" },
            },
          },
          mcp: client,
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "tools");

    expect(trace?.droppedTools).toBe(1);
    expect(trace?.toolCollisions).toEqual([
      {
        name: "searchDocs",
        winner: "mcp",
        loser: "static",
      },
    ]);
  });

  test("when no collisions occur toolCollisions is an empty array", async () => {
    const budge = createBudge();
    const client: MCPClientLike = {
      async tools() {
        return {
          getWeather: {
            description: "Weather",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const window = budge.window({
      id: "tools-trace-no-collision",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Static search",
              inputSchema: { type: "object" },
            },
          },
          mcp: client,
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "tools");

    expect(trace?.toolCollisions).toEqual([]);
  });

  test("multiple collisions across MCP clients are all recorded", async () => {
    const budge = createBudge();
    const firstClient: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "First remote search",
            inputSchema: { type: "object" },
          },
          getWeather: {
            description: "First remote weather",
            inputSchema: { type: "object" },
          },
        };
      },
    };
    const secondClient: MCPClientLike = {
      async tools() {
        return {
          searchDocs: {
            description: "Second remote search",
            inputSchema: { type: "object" },
          },
          getWeather: {
            description: "Second remote weather",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const window = budge.window({
      id: "tools-trace-multiple-collisions",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Static search",
              inputSchema: { type: "object" },
            },
            getWeather: {
              description: "Static weather",
              inputSchema: { type: "object" },
            },
          },
          mcp: [firstClient, secondClient],
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "tools");

    expect(trace?.totalTools).toBe(6);
    expect(trace?.includedTools).toBe(2);
    expect(trace?.droppedTools).toBe(4);
    expect(trace?.toolCollisions).toEqual([
      {
        name: "searchDocs",
        winner: "mcp",
        loser: "static",
      },
      {
        name: "getWeather",
        winner: "mcp",
        loser: "static",
      },
      {
        name: "searchDocs",
        winner: "mcp",
        loser: "mcp",
      },
      {
        name: "getWeather",
        winner: "mcp",
        loser: "mcp",
      },
    ]);
  });

  test("tools source works alongside history and value sources in the same window", async () => {
    const budge = createBudge();

    const accountSource = budge.source.value(
      z.object({
        threadId: z.string(),
      }),
      {
        async resolve({ input }) {
          return { id: input.threadId };
        },
      },
    );

    const window = budge.window({
      id: "tools-mixed-window",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            searchDocs: {
              description: "Search docs",
              inputSchema: { type: "object" },
            },
          },
        }),
        history: source.history(z.object({ threadId: z.string() }), {
          async resolve({ input }) {
            return [{ id: input.threadId, role: "user", content: "hello" }];
          },
        }),
        account: accountSource,
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });

    expect(result.context.tools.searchDocs?.name).toBe("searchDocs");
    expect(result.context.history).toHaveLength(1);
    expect(result.context.account).toEqual({ id: "thread_123" });
  });

  test("parallel MCP client resolution calls multiple clients concurrently", async () => {
    const budge = createBudge();
    const started: string[] = [];

    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const firstClient: MCPClientLike = {
      async tools() {
        started.push("first");
        await gate;
        return {
          searchDocs: {
            inputSchema: { type: "object" },
          },
        };
      },
    };
    const secondClient: MCPClientLike = {
      async tools() {
        started.push("second");
        await gate;
        return {
          getWeather: {
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const pending = budge.source.tools({ mcp: [firstClient, secondClient] }).resolve({});

    await waitFor(() => started.length === 2);
    releaseGate?.();

    const result = await pending;

    expect(new Set(started)).toEqual(new Set(["first", "second"]));
    expect(Object.keys(result).sort()).toEqual(["getWeather", "searchDocs"]);
  });

  test("empty config resolves to empty record without throwing", async () => {
    const budge = createBudge();

    await expect(budge.source.tools({}).resolve({})).resolves.toEqual({});
  });

  test("MCP client returning empty tools map resolves cleanly", async () => {
    const budge = createBudge();
    const client: MCPClientLike = {
      async tools() {
        return {};
      },
    };

    await expect(budge.source.tools({ mcp: client }).resolve({})).resolves.toEqual({});
  });

  test("static tools survive when one MCP client rejects", async () => {
    const budge = createBudge();
    const failingClient: MCPClientLike = {
      async tools() {
        throw new Error("mcp unavailable");
      },
    };

    await expect(
      budge.source
        .tools({
          tools: {
            searchDocs: {
              description: "Static search",
              inputSchema: { type: "object" },
            },
          },
          mcp: failingClient,
        })
        .resolve({}),
    ).resolves.toEqual({
      searchDocs: {
        name: "searchDocs",
        description: "Static search",
        inputSchema: { type: "object" },
      },
    });
  });

  test("one failed MCP client does not block tools from another successful MCP client", async () => {
    const budge = createBudge();
    const failingClient: MCPClientLike = {
      async tools() {
        throw new Error("mcp unavailable");
      },
    };
    const healthyClient: MCPClientLike = {
      async tools() {
        return {
          getWeather: {
            description: "Weather",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    await expect(
      budge.source.tools({ mcp: [failingClient, healthyClient] }).resolve({}),
    ).resolves.toEqual({
      getWeather: {
        name: "getWeather",
        description: "Weather",
        inputSchema: { type: "object" },
      },
    });
  });

  test("all MCP clients failing with no static tools still rejects", async () => {
    const budge = createBudge();
    const failingClient: MCPClientLike = {
      async tools() {
        throw new Error("mcp unavailable");
      },
    };

    await expect(budge.source.tools({ mcp: [failingClient] }).resolve({})).rejects.toThrow(
      "mcp unavailable",
    );
  });

  test("tool names from static and MCP are correctly attributed in trace fields using normalized names", async () => {
    const budge = createBudge();
    const client: MCPClientLike = {
      async tools() {
        return {
          remote_lookup: {
            description: "Remote lookup",
            inputSchema: { type: "object" },
          },
          mcp_only: {
            description: "MCP only",
            inputSchema: { type: "object" },
          },
        };
      },
    };

    const window = budge.window({
      id: "tools-trace-attribution",
      input: z.object({
        threadId: z.string(),
      }),
      sources: ({ source }) => ({
        tools: source.tools({
          tools: {
            static_lookup: {
              description: "Static lookup",
              inputSchema: { type: "object" },
            },
            static_only: {
              description: "Static only",
              inputSchema: { type: "object" },
            },
          },
          mcp: client,
          normalize(name, raw) {
            return {
              name: name.includes("lookup")
                ? "searchDocs"
                : name === "static_only"
                  ? "localOnly"
                  : "remoteOnly",
              description: typeof raw.description === "string" ? raw.description : undefined,
              inputSchema:
                typeof raw.inputSchema === "object" && raw.inputSchema !== null
                  ? (raw.inputSchema as Record<string, unknown>)
                  : {},
            };
          },
        }),
      }),
    });

    const result = await window.resolve({
      input: {
        threadId: "thread_123",
      },
    });
    const trace = result.traces.sources.find((source) => source.key === "tools");

    expect([...(trace?.toolNames ?? [])].sort()).toEqual(["localOnly", "remoteOnly", "searchDocs"]);
    expect([...(trace?.toolSources.static ?? [])].sort()).toEqual(["localOnly"]);
    expect([...(trace?.toolSources.mcp ?? [])].sort()).toEqual(["remoteOnly", "searchDocs"]);
  });
});
