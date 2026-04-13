import picomatch from "picomatch";
import type { SourceAdapter } from "./interface.ts";
import safeStableStringify from "safe-stable-stringify";

type PatternList = readonly string[] | undefined;

type PatternValues<T extends PatternList> = T extends readonly string[] ? T[number] : never;

type NoPatternOverlap<Allow extends PatternList, Deny extends PatternList> = string extends
  | PatternValues<Allow>
  | PatternValues<Deny>
  ? {}
  : [Extract<PatternValues<Allow>, PatternValues<Deny>>] extends [never]
    ? {}
    : {
        __allowDenyOverlap__: `allow and deny both include ${Extract<PatternValues<Allow>, PatternValues<Deny>> & string}`;
      };

type ExactToolMode = {
  /**
   * Exact allowlist mode. Only matching tools are exposed.
   */
  tools: readonly string[];
  readonly?: never;
  allow?: never;
  deny?: never;
};

type FilterMode<Allow extends PatternList, Deny extends PatternList> = NoPatternOverlap<
  Allow,
  Deny
> & {
  /**
   * Filter mode. Defaults to readonly filtering.
   */
  tools?: never;
  readonly?: boolean;
  allow?: Allow;
  deny?: Deny;
};

/**
 * Minimal MCP tool metadata exposed through the source API.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export type McpLikeClient =
  | {
      listTools(params?: { cursor?: string }): Promise<{
        tools: ToolDefinition[];
        nextCursor?: string;
      }>;
    }
  | {
      tools(): Promise<Record<string, ToolDefinition>>;
    };

export type McpSourceOptions<
  Allow extends PatternList = PatternList,
  Deny extends PatternList = PatternList,
> = ExactToolMode | FilterMode<Allow, Deny>;

const READONLY_PREFIXES = ["get_", "list_", "search_", "read_", "fetch_", "query_", "describe_"];

/**
 * A source adapter that exposes an MCP tool catalog as a read-only source.
 */
export class McpAdapter implements SourceAdapter {
  private readonly loadTools: () => Promise<ToolDefinition[]>;
  private readonly options: McpSourceOptions;
  private cachedTools?: Promise<ToolDefinition[]>;

  constructor(client: McpLikeClient, options: McpSourceOptions = {}) {
    this.loadTools = normalizeMcpClient(client);
    this.options = options;
  }

  describe(): string {
    return "MCP tool catalog source. Use list_source to discover exposed tools and read_source for per-tool metadata.";
  }

  async list(_path?: string): Promise<string[]> {
    const tools = await this.getTools();
    return tools.map((tool) => tool.name).sort();
  }

  async read(path: string): Promise<string> {
    const tools = await this.getTools();
    const tool = tools.find((item) => item.name === path);

    if (!tool) {
      const available = tools
        .map((item) => item.name)
        .sort()
        .join(", ");
      throw new Error(`Tool not exposed: ${path}. Available: ${available || "(none)"}`);
    }

    return formatTool(tool);
  }

  private getTools(): Promise<ToolDefinition[]> {
    this.cachedTools ??= this.loadTools().then((tools) => filterTools(tools, this.options));
    return this.cachedTools;
  }
}

export function normalizeMcpClient(client: McpLikeClient): () => Promise<ToolDefinition[]> {
  if ("listTools" in client) {
    return async () => {
      const tools: ToolDefinition[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listTools({ cursor });
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);

      return dedupeByName(tools);
    };
  }

  return async () => dedupeByName(Object.values(await client.tools()));
}

function filterTools(tools: ToolDefinition[], options: McpSourceOptions): ToolDefinition[] {
  if (options.tools && options.tools.length > 0) {
    const selected = tools.filter((tool) => matchesAny(tool.name, options.tools));
    return dedupeByName(selected);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const readonlyEnabled = options.readonly ?? true;
  const base = readonlyEnabled ? tools.filter((tool) => isReadonlyTool(tool.name)) : [...tools];
  const selected = new Map(base.map((tool) => [tool.name, tool]));

  if (options.allow) {
    for (const tool of tools) {
      if (matchesAny(tool.name, options.allow)) {
        selected.set(tool.name, tool);
      }
    }
  }

  if (options.deny) {
    for (const name of selected.keys()) {
      if (matchesAny(name, options.deny)) {
        selected.delete(name);
      }
    }
  }

  // Preserve the original tool object when a name is re-added via allow.
  return dedupeByName(
    [...selected.keys()]
      .map((name) => byName.get(name))
      .filter((tool): tool is ToolDefinition => tool != null),
  );
}

function dedupeByName(tools: ToolDefinition[]): ToolDefinition[] {
  const unique = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    unique.set(tool.name, tool);
  }

  return [...unique.values()];
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  return picomatch(Array.from(patterns))(name);
}

function isReadonlyTool(name: string): boolean {
  const lower = name.toLowerCase();
  return READONLY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function formatTool(tool: ToolDefinition): string {
  const { name, description, inputSchema, ...rest } = tool;
  const output = [
    `Tool: ${name}`,
    `Description: ${description ?? "(none)"}`,
    "Input schema:",
    safeStringify(inputSchema ?? {}),
  ];

  if (Object.keys(rest).length > 0) {
    output.push("Metadata:", safeStringify(rest));
  }

  return output.join("\n");
}

function safeStringify(value: unknown): string {
  return safeStableStringify(value) ?? "null";
}
