import type { Trace } from "@budge/core";
import { z } from "zod";
import { budge } from "./budge.ts";
import { accountSource, billingNotesSource, recentTicketsSource } from "./sourceRegistry.ts";

const supportReplyInputSchema = z.object({
  accountId: z.string(),
  transcript: z.string(),
});

export const supportReplyWindow = budge.window({
  id: "support_reply",
  input: supportReplyInputSchema,
  maxTokens: 700,
  async compose({ input, use }) {
    const account = await use(accountSource, {
      accountId: input.accountId,
    });

    const mentionsBilling = /\b(invoice|refund|charge|billing)\b/i.test(input.transcript);
    const billingNotes = mentionsBilling
      ? await use(billingNotesSource, { accountId: input.accountId })
      : undefined;

    const recentTickets = await use(recentTicketsSource, {
      accountId: input.accountId,
      transcript: input.transcript,
    });

    return {
      system: `You are a support engineer drafting a ${account.tier === "priority" ? "concise" : "standard"} customer reply for ${account.name}. ${
        account.plan === "enterprise"
          ? "Prioritize urgency and ownership."
          : "Keep the reply practical and direct."
      }`,
      prompt:
        `Customer message:\n${input.transcript}` +
        `\n\nAccount:\n${account}` +
        (recentTickets.length ? `\n\nRelevant docs:\n${recentTickets}` : "") +
        (billingNotes ? `\n\nBilling notes:\n${billingNotes}` : ""),
    };
  },
});

export function summarizeTrace(trace: Trace): string {
  const lines = [
    `run: ${trace.runId}`,
    `window: ${trace.windowId}`,
    `budget: ${trace.budget.used}/${trace.budget.max ?? "unbounded"}`,
    `prompt tokens: ${trace.prompt.totalTokens} (system: ${trace.prompt.systemTokens}, prompt: ${trace.prompt.promptTokens})`,
    "sources:",
  ];

  lines.push(
    ...trace.sources.map((source) => {
      const itemCount = source.itemCount !== undefined ? `, items=${source.itemCount}` : "";
      return `  - ${source.sourceId}: ${source.kind} (${source.durationMs}ms${itemCount})`;
    }),
  );

  return lines.join("\n");
}
