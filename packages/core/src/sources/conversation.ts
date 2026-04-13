import type { SourceAdapter } from "./interface.ts";

/**
 * A message in a conversation history.
 *
 * Intentionally mirrors the shape of AI SDK `CoreMessage` so that
 * developers using the AI SDK can pass their message arrays directly.
 */
export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: Date;
}

/**
 * A source adapter that exposes a conversation history as a navigable source.
 *
 * Messages are addressed by zero-based index. The `read()` method accepts:
 * - `"5"`    → single message at index 5
 * - `"5:10"` → messages at indices 5 through 9 (start inclusive, end exclusive)
 * - `":10"`  → first 10 messages
 * - `"20:"`  → messages from index 20 to the end
 *
 * @example
 * ```ts
 * const history = source.conversation(messages)
 * ```
 */
export class ConversationAdapter implements SourceAdapter {
  private readonly messages: ConversationMessage[];

  constructor(messages: ConversationMessage[]) {
    this.messages = messages;
  }

  describe(): string {
    const count = this.messages.length;
    if (count === 0) return "Conversation history — empty";

    const withDates = this.messages.filter((m) => m.createdAt != null);
    const dateRange =
      withDates.length >= 2
        ? ` (${fmt(withDates[0]!.createdAt!)} – ${fmt(withDates[withDates.length - 1]!.createdAt!)})`
        : "";

    const roles = roleSummary(this.messages);
    return `Conversation history — ${count} message${count === 1 ? "" : "s"}${dateRange}. ${roles}`;
  }

  async list(_path?: string): Promise<string[]> {
    return this.messages.map((_, i) => String(i));
  }

  async read(address: string): Promise<string> {
    const slice = parseAddress(address, this.messages.length);
    const selected = this.messages.slice(slice.start, slice.end);

    if (selected.length === 0) {
      throw new Error(`No messages at address "${address}" (total: ${this.messages.length})`);
    }

    return JSON.stringify(
      selected.map((m, i) => ({
        index: slice.start + i,
        role: m.role,
        content: m.content,
        ...(m.createdAt ? { createdAt: m.createdAt.toISOString() } : {}),
      })),
      null,
      2,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Slice {
  start: number;
  end: number;
}

/**
 * Parses a message address into a half-open `[start, end)` range.
 *
 * Accepted formats:
 *   "5"     → [5, 6]
 *   "5:10"  → [5, 10]
 *   ":10"   → [0, 10]
 *   "20:"   → [20, total]
 */
function parseAddress(address: string, total: number): Slice {
  const trimmed = address.trim();

  if (trimmed.includes(":")) {
    const [startStr, endStr] = trimmed.split(":") as [string, string];
    const start = startStr === "" ? 0 : parseInt(startStr, 10);
    const end = endStr === "" ? total : parseInt(endStr, 10);

    if (isNaN(start) || isNaN(end)) {
      throw new Error(`Invalid message address: "${address}"`);
    }

    return { start: clamp(start, 0, total), end: clamp(end, 0, total) };
  }

  const index = parseInt(trimmed, 10);
  if (isNaN(index)) {
    throw new Error(`Invalid message address: "${address}"`);
  }

  return { start: clamp(index, 0, total), end: clamp(index + 1, 0, total) };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function fmt(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function roleSummary(messages: ConversationMessage[]): string {
  const counts: Record<string, number> = {};
  for (const m of messages) {
    counts[m.role] = (counts[m.role] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([role, n]) => `${n} ${role}`)
    .join(", ");
}
