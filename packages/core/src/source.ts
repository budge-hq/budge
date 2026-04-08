import type {
  AnyInput,
  AnyResolverSource,
  AnySchema,
  Chunk,
  DependentRagSourceConfig,
  DependentSourceConfig,
  FromInputSourceOptions,
  HistorySource,
  HistorySourceConfig,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InputSource,
  InputSchema,
  MCPClientLike,
  Message,
  MessageKind,
  RagSource,
  RagSourceConfig,
  SourceDepValues,
  SourceResolveArgs,
  SourceConfig,
  ToolDefinition,
  ToolsSource,
  ToolsSourceConfig,
  ValueSource,
} from "./types.ts";

let nextSourceInternalId = 0;

const DEFAULT_HISTORY_MAX_MESSAGES = 20;

interface HistoryTraceMetadata {
  totalMessages: number;
  includedMessages: number;
  droppedMessages: number;
  droppedByKind: Record<string, number>;
  compactionDroppedMessages: number;
  strategy: "sliding";
  maxMessages: number;
}

interface ToolsTraceMetadata {
  totalTools: number;
  includedTools: number;
  droppedTools: number;
  toolNames: string[];
  toolSources: {
    static: string[];
    mcp: string[];
  };
}

const historyTraceMetadataSymbol = Symbol("budge.historyTraceMetadata");
const toolsTraceMetadataSymbol = Symbol("budge.toolsTraceMetadata");

function createSourceInternalId(): string {
  return `src_${nextSourceInternalId++}`;
}

function isChunk(value: unknown): value is Chunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string"
  );
}

function isChunkArray(values: unknown): values is Chunk[] {
  return Array.isArray(values) && values.every(isChunk);
}

function attachHistoryTraceMetadata(
  messages: Message[],
  metadata: HistoryTraceMetadata,
): Message[] {
  // Keep history values as plain arrays for developers while carrying trace-only metadata
  // to the wave executor via a non-enumerable symbol.
  Object.defineProperty(messages, historyTraceMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });

  return messages;
}

export function readHistoryTraceMetadata(value: unknown): HistoryTraceMetadata | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  // The symbol is module-private, so a narrow assertion is required to read the
  // non-enumerable metadata attached by createHistorySource().
  return (value as Message[] & { [historyTraceMetadataSymbol]?: HistoryTraceMetadata })[
    historyTraceMetadataSymbol
  ];
}

function attachToolsTraceMetadata(
  tools: Record<string, ToolDefinition>,
  metadata: ToolsTraceMetadata,
): Record<string, ToolDefinition> {
  // Keep tool maps as plain records for developers while carrying trace-only metadata
  // to the wave executor via a non-enumerable symbol.
  Object.defineProperty(tools, toolsTraceMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });

  return tools;
}

export function readToolsTraceMetadata(value: unknown): ToolsTraceMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return (
    value as Record<string, ToolDefinition> & {
      [toolsTraceMetadataSymbol]?: ToolsTraceMetadata;
    }
  )[toolsTraceMetadataSymbol];
}

function resolveMessageKind(message: Message): MessageKind {
  if (message.kind) {
    return message.kind;
  }

  if (message.role === "tool") {
    return "tool_result";
  }

  return "text";
}

async function validateSourceInput<TSchema extends InputSchema<AnyInput, AnyInput>>(
  schema: TSchema,
  input: AnyInput,
): Promise<InferSchemaOutputObject<TSchema>> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Source input validation failed: ${details}`);
  }

  return result.value as InferSchemaOutputObject<TSchema>;
}

async function validateSourceOutput<TOutput>(
  schema: AnySchema | undefined,
  value: TOutput,
): Promise<TOutput> {
  if (!schema) {
    return value;
  }

  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue: { message: string }) => issue.message).join("; ");
    throw new Error(`Source output validation failed: ${details}`);
  }

  return result.value as TOutput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultNormalizeTool(name: string, raw: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    // Missing inputSchema defaults to {}. In JSON Schema this means "any input",
    // and Budge stays permissive about upstream tool definitions instead of throwing.
    inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : {},
  };
}

function normalizeToolDefinition(
  name: string,
  raw: Record<string, unknown>,
  normalize?: ToolsSourceConfig["normalize"],
): ToolDefinition {
  return normalize ? normalize(name, raw) : defaultNormalizeTool(name, raw);
}

function toRawToolEntry(tool: {
  description?: string;
  inputSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  // Preserve the full raw payload so normalize() can inspect MCP extensions and other
  // provider-specific fields beyond the minimal Budge-owned tool shape.
  return tool as Record<string, unknown>;
}

function normalizeMcpClients(mcp: MCPClientLike | MCPClientLike[] | undefined): MCPClientLike[] {
  if (!mcp) {
    return [];
  }

  return Array.isArray(mcp) ? mcp : [mcp];
}

export function createFromInputSource<TKey extends string>(
  key: TKey,
  options?: FromInputSourceOptions,
): InputSource<TKey> {
  return {
    _type: "input",
    _internalId: createSourceInternalId(),
    _sourceKind: "input",
    _key: key,
    _tags: options?.tags ?? [],
  };
}

export function createValueSource<TSchema extends InputSchema<AnyInput, AnyInput>, TOutput>(
  inputSchema: TSchema,
  config: SourceConfig<InferSchemaOutputObject<TSchema>, TOutput>,
): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>> {
  return createDependentValueSource(inputSchema, {}, config);
}

export function createDependentValueSource<
  TSchema extends InputSchema<AnyInput, AnyInput>,
  const TDeps extends Record<string, AnyResolverSource>,
  TOutput,
>(
  inputSchema: TSchema,
  dependencies: TDeps,
  config: DependentSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TOutput>,
): ValueSource<Awaited<TOutput>, InferSchemaInputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "value",
    _dependencySources: dependencies,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(
      runtimeInput: InferSchemaInputObject<TSchema>,
      context: Record<string, unknown> = {},
    ): Promise<Awaited<TOutput>> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolveArgs = {
        input: normalizedInput,
        ...context,
      } as unknown as SourceResolveArgs<InferSchemaOutputObject<TSchema>> & SourceDepValues<TDeps>;
      const resolved = await config.resolve(resolveArgs);
      return await validateSourceOutput(config.output, resolved as Awaited<TOutput>);
    },
  };
}

export function createRagSource<TSchema extends InputSchema<AnyInput, AnyInput>, TItem>(
  inputSchema: TSchema,
  config: RagSourceConfig<InferSchemaOutputObject<TSchema>, TItem>,
): RagSource<InferSchemaInputObject<TSchema>> {
  return createDependentRagSource(inputSchema, {}, config);
}

export function createDependentRagSource<
  TSchema extends InputSchema<AnyInput, AnyInput>,
  const TDeps extends Record<string, AnyResolverSource>,
  TItem,
>(
  inputSchema: TSchema,
  dependencies: TDeps,
  config: DependentRagSourceConfig<InferSchemaOutputObject<TSchema>, TDeps, TItem>,
): RagSource<InferSchemaInputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "rag",
    _dependencySources: dependencies,
    output: config.output,
    tags: config.tags ?? [],
    async resolve(
      runtimeInput: InferSchemaInputObject<TSchema>,
      context: Record<string, unknown> = {},
    ): Promise<Chunk[]> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolveArgs = {
        input: normalizedInput,
        ...context,
      } as unknown as SourceResolveArgs<InferSchemaOutputObject<TSchema>> & SourceDepValues<TDeps>;
      const result = await config.resolve(resolveArgs);
      const validated = await validateSourceOutput(config.output, result);

      if (!Array.isArray(validated)) {
        throw new TypeError("budge.source.rag() resolve() must return an array.");
      }

      if (config.normalize) {
        const normalizedItems = validated.map((item) => config.normalize!(item as TItem));

        if (!isChunkArray(normalizedItems)) {
          throw new TypeError(
            "budge.source.rag() normalize() must return Chunk objects with string content.",
          );
        }

        return normalizedItems;
      }

      if (!isChunkArray(validated)) {
        throw new TypeError(
          "budge.source.rag() requires either Chunk[] input or a normalize function.",
        );
      }

      return validated;
    },
  };
}

export function createHistorySource<TSchema extends InputSchema<AnyInput, AnyInput>>(
  inputSchema: TSchema,
  config: HistorySourceConfig<InferSchemaOutputObject<TSchema>>,
): HistorySource<InferSchemaInputObject<TSchema>> {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "history",
    _dependencySources: {},
    tags: config.tags ?? [],
    async resolve(
      runtimeInput: InferSchemaInputObject<TSchema>,
      _context: Record<string, unknown> = {},
    ): Promise<Message[]> {
      const normalizedInput = await validateSourceInput(inputSchema, runtimeInput);
      const resolved = await config.resolve({ input: normalizedInput });

      if (!Array.isArray(resolved)) {
        throw new TypeError("budge.source.history() resolve() must return an array.");
      }

      const excludedKinds = new Set(config.filter?.excludeKinds ?? []);
      const droppedByKind: Record<string, number> = {};

      const filtered = resolved.filter((message) => {
        const kind = resolveMessageKind(message);
        if (!excludedKinds.has(kind)) {
          return true;
        }

        droppedByKind[kind] = (droppedByKind[kind] ?? 0) + 1;
        return false;
      });

      const maxMessages = Math.max(
        config.compaction?.maxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES,
        0,
      );
      const compacted = maxMessages === 0 ? [] : filtered.slice(-maxMessages);
      const compactionDroppedMessages = filtered.length - compacted.length;

      return attachHistoryTraceMetadata(compacted, {
        totalMessages: resolved.length,
        includedMessages: compacted.length,
        droppedMessages: resolved.length - compacted.length,
        droppedByKind,
        compactionDroppedMessages,
        strategy: config.compaction?.strategy ?? "sliding",
        maxMessages,
      });
    },
  };
}

export function createToolsSource(config: ToolsSourceConfig): ToolsSource {
  return {
    _type: "resolver",
    _internalId: createSourceInternalId(),
    _sourceKind: "tools",
    _dependencySources: {},
    tags: config.tags ?? [],
    async resolve(
      _input: AnyInput,
      _context: Record<string, unknown> = {},
    ): Promise<Record<string, ToolDefinition>> {
      const mergedTools = new Map<string, ToolDefinition>();
      const toolOrigins = new Map<string, "static" | "mcp">();

      const addTool = (
        origin: "static" | "mcp",
        rawName: string,
        rawTool: Record<string, unknown>,
      ) => {
        const normalizedTool = normalizeToolDefinition(rawName, rawTool, config.normalize);

        // When normalization changes names, the final record is keyed by the normalized
        // ToolDefinition.name. If multiple tools normalize to the same name, last writer wins.
        mergedTools.set(normalizedTool.name, normalizedTool);
        toolOrigins.set(normalizedTool.name, origin);
      };

      for (const [name, tool] of Object.entries(config.tools ?? {})) {
        addTool("static", name, toRawToolEntry(tool));
      }

      const mcpResults = await Promise.all(
        normalizeMcpClients(config.mcp).map((client) => client.tools()),
      );

      for (const tools of mcpResults) {
        for (const [name, tool] of Object.entries(tools)) {
          addTool("mcp", name, toRawToolEntry(tool));
        }
      }

      const toolsRecord = Object.fromEntries(mergedTools) as Record<string, ToolDefinition>;
      const toolNames = [...mergedTools.keys()];

      return attachToolsTraceMetadata(toolsRecord, {
        totalTools: toolNames.length,
        includedTools: toolNames.length,
        droppedTools: 0,
        toolNames,
        toolSources: {
          static: toolNames.filter((name) => toolOrigins.get(name) === "static"),
          mcp: toolNames.filter((name) => toolOrigins.get(name) === "mcp"),
        },
      });
    },
  };
}
