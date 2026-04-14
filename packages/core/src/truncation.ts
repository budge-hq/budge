import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_LIMITS = {
  READ_MAX_LINES: 2_000,
  READ_MAX_CHARS_PER_LINE: 2_000,
  READ_MAX_BYTES: 50 * 1024,
  LIST_MAX_ENTRIES: 1_000,
  SUBCALL_MAX_BYTES: 30 * 1024,
} as const;

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
  direction?: "head" | "tail" | "middle";
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  overflowPath?: string;
  removed?: { unit: "lines" | "bytes"; count: number };
}

export interface TruncateContext {
  toolName: string;
  hasSubcalls: boolean;
}

export class Truncator {
  private readonly overflowDir: string;
  private readonly retentionMs: number;
  private readonly enabled: boolean;

  constructor(options: { overflowDir?: string; retentionMs?: number; enabled?: boolean } = {}) {
    this.overflowDir = options.overflowDir ?? path.join(os.tmpdir(), "budge-overflow");
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.enabled = options.enabled ?? true;
  }

  async apply(
    text: string,
    options: TruncateOptions,
    context: TruncateContext,
  ): Promise<TruncateResult> {
    const direction = options.direction ?? "head";
    const originalLineCount = countLines(text);
    const originalByteCount = byteLength(text);

    let preview = text;
    let removed: TruncateResult["removed"];

    if (options.maxLines !== undefined) {
      const lineLimited = truncateByLines(preview, Math.max(0, options.maxLines), direction);
      if (lineLimited) {
        preview = lineLimited.content;
        removed = { unit: "lines", count: originalLineCount - lineLimited.keptLineCount };
      }
    }

    if (options.maxBytes !== undefined) {
      const byteLimited = truncateByBytes(preview, Math.max(0, options.maxBytes), direction);
      if (byteLimited) {
        preview = byteLimited.content;
        removed = { unit: "bytes", count: originalByteCount - byteLength(preview) };
      }
    }

    if (preview === text) {
      return { content: text, truncated: false };
    }

    const overflowPath = await this.writeOverflow(text, context.toolName);
    const hint = buildHint(
      removed ?? { unit: "bytes", count: 0 },
      overflowPath,
      context.hasSubcalls,
    );

    return {
      content: `${preview}${hint}`,
      truncated: true,
      overflowPath,
      removed,
    };
  }

  async applyArray<T>(
    items: T[],
    maxItems: number,
    formatter: (items: T[]) => string,
    context: TruncateContext & { itemType: string },
  ): Promise<TruncateResult> {
    const safeMaxItems = Math.max(0, maxItems);
    if (items.length <= safeMaxItems) {
      return {
        content: formatter(items),
        truncated: false,
      };
    }

    const previewItems = items.slice(0, safeMaxItems);
    const preview = formatter(previewItems);
    const full = formatter(items);
    const removed = { unit: "lines" as const, count: items.length - previewItems.length };
    const overflowPath = await this.writeOverflow(full, context.toolName);
    const hint = buildHint(removed, overflowPath, context.hasSubcalls);

    return {
      content: `${preview}${hint}`,
      truncated: true,
      overflowPath,
      removed,
    };
  }

  async cleanup(): Promise<void> {
    const entries = await fs.readdir(this.overflowDir, { withFileTypes: true }).catch(() => []);
    const cutoffMs = Date.now() - this.retentionMs;

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const absolutePath = path.join(this.overflowDir, entry.name);
        const stats = await fs.stat(absolutePath).catch(() => undefined);
        if (!stats || stats.mtimeMs >= cutoffMs) return;
        await fs.unlink(absolutePath).catch(() => {});
      }),
    );
  }

  private async writeOverflow(text: string, toolName: string): Promise<string | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const filename = `${sanitizeToolName(toolName)}-${Date.now()}-${createRandomId()}.txt`;

    try {
      await fs.mkdir(this.overflowDir, { recursive: true });
      const overflowPath = path.join(this.overflowDir, filename);
      await fs.writeFile(overflowPath, text, "utf8");
      return overflowPath;
    } catch {
      return undefined;
    }
  }
}

function buildHint(
  removed: NonNullable<TruncateResult["removed"]>,
  overflowPath: string | undefined,
  hasSubcalls: boolean,
): string {
  const saved = overflowPath ? ` Full content saved to ${overflowPath}.` : "";
  const tip = hasSubcalls
    ? " Tip: use run_subcall with this path to have a worker analyze the full content without polluting your context."
    : " Tip: re-run with a narrower path or smaller offset.";

  return `\n\n[Output truncated. ${removed.count} ${removed.unit} omitted.${saved}]${tip}`;
}

function truncateByLines(
  text: string,
  maxLines: number,
  direction: NonNullable<TruncateOptions["direction"]>,
): { content: string; keptLineCount: number } | undefined {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return undefined;
  }

  if (maxLines === 0) {
    return { content: "", keptLineCount: 0 };
  }

  if (direction === "tail") {
    const kept = lines.slice(-maxLines);
    return { content: kept.join("\n"), keptLineCount: kept.length };
  }

  if (direction === "middle") {
    const headCount = Math.ceil(maxLines / 2);
    const tailCount = Math.floor(maxLines / 2);
    const head = lines.slice(0, headCount);
    const tail = tailCount === 0 ? [] : lines.slice(lines.length - tailCount);
    return {
      content: [...head, ...tail].join("\n"),
      keptLineCount: head.length + tail.length,
    };
  }

  const kept = lines.slice(0, maxLines);
  return { content: kept.join("\n"), keptLineCount: kept.length };
}

function truncateByBytes(
  text: string,
  maxBytes: number,
  direction: NonNullable<TruncateOptions["direction"]>,
): { content: string } | undefined {
  if (byteLength(text) <= maxBytes) {
    return undefined;
  }

  if (maxBytes === 0) {
    return { content: "" };
  }

  if (direction === "tail") {
    return { content: fitSuffix(text, maxBytes) };
  }

  if (direction === "middle") {
    const prefixBudget = Math.ceil(maxBytes / 2);
    const prefixLength = fitPrefixLength(text, prefixBudget);
    const prefix = text.slice(0, prefixLength);
    const remainingBudget = Math.max(0, maxBytes - byteLength(prefix));
    const suffix = fitSuffix(text.slice(prefixLength), remainingBudget);
    return { content: `${prefix}${suffix}` };
  }

  return { content: fitPrefix(text, maxBytes) };
}

function fitPrefix(text: string, maxBytes: number): string {
  return text.slice(0, fitPrefixLength(text, maxBytes));
}

function fitPrefixLength(text: string, maxBytes: number): number {
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

function fitSuffix(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(text.slice(mid)) <= maxBytes) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return text.slice(low);
}

function sanitizeToolName(toolName: string): string {
  return toolName.replaceAll(/[\\/]/g, "-");
}

function createRandomId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
