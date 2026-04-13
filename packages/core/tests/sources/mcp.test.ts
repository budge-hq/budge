import { describe, expect, it, vi } from "vite-plus/test";
import {
  McpAdapter,
  type McpLikeClient,
  type ToolDefinition,
  normalizeMcpClient,
} from "../../src/sources/mcp.ts";
import { source } from "../../src/sources/index.ts";

const TOOL_FIXTURES: ToolDefinition[] = [
  {
    name: "get_patient",
    description: "Fetch a patient record",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_encounters",
    description: "List encounter summaries",
    inputSchema: { type: "object" },
  },
  {
    name: "search_medications",
    description: "Search medications",
    inputSchema: { type: "object" },
  },
  {
    name: "update_draft_note",
    description: "Update the note draft",
    inputSchema: { type: "object" },
  },
  {
    name: "delete_patient",
    description: "Delete a patient",
    inputSchema: { type: "object" },
  },
  {
    name: "get_sensitive_phi",
    description: "Fetch highly sensitive PHI",
    inputSchema: { type: "object" },
  },
];

function makeListToolsClient(): McpLikeClient & {
  listTools: ReturnType<typeof vi.fn>;
} {
  const listTools = vi.fn(async (params?: { cursor?: string }) => {
    if (!params?.cursor) {
      return {
        tools: [TOOL_FIXTURES[0]!, TOOL_FIXTURES[3]!],
        nextCursor: "page-2",
      };
    }

    return {
      tools: [TOOL_FIXTURES[1]!, TOOL_FIXTURES[2]!, TOOL_FIXTURES[4]!, TOOL_FIXTURES[5]!],
    };
  });

  return { listTools };
}

function makeToolsClient(): McpLikeClient & {
  tools: ReturnType<typeof vi.fn>;
} {
  const tools = vi.fn(async () =>
    Object.fromEntries(TOOL_FIXTURES.map((tool) => [tool.name, tool] as const)),
  );

  return { tools };
}

describe("McpSourceOptions typing", () => {
  it("separates exact allowlist mode from filter mode", () => {
    const client = makeToolsClient();

    expect(source.mcp(client, { tools: ["get_patient"] as const })).toBeInstanceOf(McpAdapter);
    expect(
      source.mcp(client, {
        allow: ["get_patient"] as const,
        deny: ["get_sensitive_phi"] as const,
      }),
    ).toBeInstanceOf(McpAdapter);

    // @ts-expect-error tools mode cannot mix with filter fields
    source.mcp(client, { tools: ["get_patient"] as const, deny: ["get_sensitive_phi"] as const });

    // @ts-expect-error exact overlap is rejected in filter mode
    source.mcp(client, { allow: ["get_patient"] as const, deny: ["get_patient"] as const });
  });
});

describe("normalizeMcpClient()", () => {
  it("paginates official listTools() clients", async () => {
    const client = makeListToolsClient();
    const loadTools = normalizeMcpClient(client);
    const tools = await loadTools();

    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.listTools).toHaveBeenNthCalledWith(1, { cursor: undefined });
    expect(client.listTools).toHaveBeenNthCalledWith(2, { cursor: "page-2" });
    expect(tools.map((tool) => tool.name)).toEqual([
      "get_patient",
      "update_draft_note",
      "list_encounters",
      "search_medications",
      "delete_patient",
      "get_sensitive_phi",
    ]);
  });

  it("supports simple tools() clients", async () => {
    const client = makeToolsClient();
    const loadTools = normalizeMcpClient(client);
    const tools = await loadTools();

    expect(client.tools).toHaveBeenCalledTimes(1);
    expect(tools).toHaveLength(TOOL_FIXTURES.length);
  });
});

describe("McpAdapter.describe()", () => {
  it("is synchronous and does not touch the client", () => {
    const client = {
      listTools: vi.fn(async () => ({ tools: TOOL_FIXTURES })),
    } satisfies McpLikeClient;

    const adapter = new McpAdapter(client);
    const description = adapter.describe();

    expect(typeof description).toBe("string");
    expect(description).toContain("MCP tool catalog source");
    expect(client.listTools).not.toHaveBeenCalled();

    adapter.describe();
    expect(client.listTools).not.toHaveBeenCalled();
  });
});

describe("McpAdapter.list()", () => {
  it("defaults to readonly filtering", async () => {
    const adapter = new McpAdapter(makeToolsClient());
    await expect(adapter.list()).resolves.toEqual([
      "get_patient",
      "get_sensitive_phi",
      "list_encounters",
      "search_medications",
    ]);
  });

  it("can disable readonly filtering", async () => {
    const adapter = new McpAdapter(makeToolsClient(), { readonly: false });
    const tools = await adapter.list();

    expect(tools).toContain("update_draft_note");
    expect(tools).toContain("delete_patient");
  });

  it("uses tools as a glob-based allowlist", async () => {
    const adapter = new McpAdapter(makeToolsClient(), {
      tools: ["get_*", "update_*"],
    });

    await expect(adapter.list()).resolves.toEqual([
      "get_patient",
      "get_sensitive_phi",
      "update_draft_note",
    ]);
  });

  it("allows specific tools back in after readonly filtering", async () => {
    const adapter = new McpAdapter(makeToolsClient(), {
      allow: ["update_*"] as const,
    });

    await expect(adapter.list()).resolves.toEqual([
      "get_patient",
      "get_sensitive_phi",
      "list_encounters",
      "search_medications",
      "update_draft_note",
    ]);
  });

  it("applies deny last so deny always wins", async () => {
    const adapter = new McpAdapter(makeToolsClient(), {
      readonly: false,
      allow: ["get_*", "update_*"] as const,
      deny: ["get_sensitive_phi", "update_*"] as const,
    });

    await expect(adapter.list()).resolves.toEqual([
      "delete_patient",
      "get_patient",
      "list_encounters",
      "search_medications",
    ]);
  });

  it("caches tool discovery across list and read", async () => {
    const client = makeListToolsClient();
    const adapter = new McpAdapter(client);

    await adapter.list();
    await adapter.read("get_patient");
    await adapter.list();

    expect(client.listTools).toHaveBeenCalledTimes(2);
  });

  it("retries discovery after a transient failure", async () => {
    const client = {
      listTools: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary outage"))
        .mockResolvedValueOnce({ tools: TOOL_FIXTURES }),
    } satisfies McpLikeClient;
    const adapter = new McpAdapter(client);

    await expect(adapter.list()).rejects.toThrow("temporary outage");
    await expect(adapter.list()).resolves.toEqual([
      "get_patient",
      "get_sensitive_phi",
      "list_encounters",
      "search_medications",
    ]);

    expect(client.listTools).toHaveBeenCalledTimes(2);
  });
});

describe("McpAdapter.read()", () => {
  it("reads formatted tool metadata", async () => {
    const adapter = new McpAdapter(makeToolsClient(), {
      tools: ["get_patient"],
    });

    const output = await adapter.read("get_patient");
    expect(output).toContain("Tool: get_patient");
    expect(output).toContain("Fetch a patient record");
    expect(output).toContain("Input schema:");
    expect(output).toContain("readOnlyHint");
  });

  it("throws with a helpful error for non-exposed tools", async () => {
    const adapter = new McpAdapter(makeToolsClient(), {
      deny: ["get_sensitive_phi"],
    });

    await expect(adapter.read("get_sensitive_phi")).rejects.toThrow(/available/i);
  });
});
