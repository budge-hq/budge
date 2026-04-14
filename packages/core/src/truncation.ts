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

const MIDDLE_LINE_MARKER = "[... truncated middle ...]";
const MIDDLE_BYTE_MARKERS = ["\n[... truncated middle ...]\n", "\n[...]\n", "[...]"] as const;

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
  maxCharsPerLine?: number;
  direction?: "head" | "tail" | "middle";
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  overflowPath?: string;
  removed?: Array<{ unit: "lines" | "bytes" | "chars"; count: number }>;
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

    let preview = text;
    const removed: NonNullable<TruncateResult["removed"]> = [];
    let lineClampNotice: string | undefined;

    if (options.maxCharsPerLine !== undefined) {
      const charLimited = truncateByLineChars(preview, Math.max(0, options.maxCharsPerLine));
      if (charLimited) {
        preview = charLimited.content;
        removed.push({ unit: "chars", count: charLimited.removedCharCount });
        lineClampNotice = `[Some lines exceeded ${options.maxCharsPerLine} characters and were truncated.]`;
      }
    }

    if (options.maxLines !== undefined) {
      const previousLineCount = countLines(preview);
      const lineLimited = truncateByLines(preview, Math.max(0, options.maxLines), direction);
      if (lineLimited) {
        preview = lineLimited.content;
        removed.push({ unit: "lines", count: previousLineCount - lineLimited.keptLineCount });
      }
    }

    if (options.maxBytes !== undefined) {
      const previousByteCount = byteLength(preview);
      const byteLimited = truncateByBytes(preview, Math.max(0, options.maxBytes), direction);
      if (byteLimited) {
        preview = byteLimited.content;
        removed.push({ unit: "bytes", count: previousByteCount - byteLimited.keptByteCount });
      }
    }

    if (preview === text) {
      return { content: text, truncated: false };
    }

    const overflowPath = await this.writeOverflow(text, context.toolName);
    const hint = buildHint(removed, overflowPath, context.hasSubcalls, lineClampNotice);

    return {
      content: `${preview}${hint}`,
      truncated: true,
      overflowPath,
      removed: removed.length === 0 ? undefined : removed,
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
    const removed = [{ unit: "lines" as const, count: items.length - previewItems.length }];
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
  lineClampNotice?: string,
): string {
  const saved = overflowPath ? ` Full content saved to ${overflowPath}.` : "";
  const tip = hasSubcalls
    ? " Tip: use run_subcall on the original source path to have a worker analyze the full content without polluting your context."
    : " Tip: re-run with a narrower path or smaller offset.";
  const notices = lineClampNotice ? `\n\n${lineClampNotice}` : "";

  return `${notices}\n\n[Output truncated. ${formatRemoved(removed)} omitted.${saved}]${tip}`;
}

function formatRemoved(removed: NonNullable<TruncateResult["removed"]>): string {
  const order = { chars: 0, lines: 1, bytes: 2 } as const;

  return [...removed]
    .sort((a, b) => order[a.unit] - order[b.unit])
    .map((entry) => `${entry.count} ${entry.unit}`)
    .join(", ");
}

function truncateByLineChars(
  text: string,
  maxCharsPerLine: number,
): { content: string; removedCharCount: number } | undefined {
  const lines = text.split("\n");
  let changed = false;
  let removedCharCount = 0;

  const clamped = lines.map((line) => {
    if (line.length <= maxCharsPerLine) {
      return line;
    }

    changed = true;
    removedCharCount += line.length - maxCharsPerLine;
    return `${line.slice(0, maxCharsPerLine)}... [line truncated]`;
  });

  if (!changed) {
    return undefined;
  }

  return {
    content: clamped.join("\n"),
    removedCharCount,
  };
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
      content: [...head, MIDDLE_LINE_MARKER, ...tail].join("\n"),
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
): { content: string; keptByteCount: number } | undefined {
  if (byteLength(text) <= maxBytes) {
    return undefined;
  }

  if (maxBytes === 0) {
    return { content: "", keptByteCount: 0 };
  }

  if (direction === "tail") {
    const content = fitSuffix(text, maxBytes);
    return { content, keptByteCount: byteLength(content) };
  }

  if (direction === "middle") {
    const marker = pickMiddleByteMarker(maxBytes);
    if (!marker) {
      const content = fitPrefix(text, maxBytes);
      return { content, keptByteCount: byteLength(content) };
    }

    const markerBytes = byteLength(marker);
    const contentBudget = Math.max(0, maxBytes - markerBytes);
    const prefixBudget = Math.ceil(contentBudget / 2);
    const suffixBudget = Math.floor(contentBudget / 2);
    const prefixLength = fitPrefixLength(text, prefixBudget);
    const prefix = text.slice(0, prefixLength);
    const suffix = fitSuffix(text.slice(prefixLength), suffixBudget);
    return {
      content: `${prefix}${marker}${suffix}`,
      keptByteCount: byteLength(prefix) + byteLength(suffix),
    };
  }

  const content = fitPrefix(text, maxBytes);
  return { content, keptByteCount: byteLength(content) };
}

function pickMiddleByteMarker(maxBytes: number): string | undefined {
  return MIDDLE_BYTE_MARKERS.find((marker) => byteLength(marker) <= maxBytes);
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
