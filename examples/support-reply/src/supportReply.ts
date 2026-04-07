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
  sources: ({ source }) => ({
    transcript: source.fromInput("transcript", { tags: ["restricted"] }),
    account: accountSource,
    billingNotes: billingNotesSource,
    recentTickets: recentTicketsSource,
  }),
});

type SupportReplyContext = Awaited<ReturnType<(typeof supportReplyWindow)["resolve"]>>["context"];

function formatStructured(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildSupportReplyPrompt(context: SupportReplyContext): {
  system: string;
  prompt: string;
} {
  const mentionsBilling = /\b(invoice|refund|charge|billing)\b/i.test(context.transcript);
  const billingNotes = mentionsBilling ? context.billingNotes : undefined;

  return {
    system: `You are a support engineer drafting a ${context.account.tier === "priority" ? "concise" : "standard"} customer reply for ${context.account.name}. ${
      context.account.plan === "enterprise"
        ? "Prioritize urgency and ownership."
        : "Keep the reply practical and direct."
    }`,
    prompt:
      `Customer message:\n${context.transcript}` +
      `\n\nAccount:\n${formatStructured(context.account)}` +
      (context.recentTickets.length
        ? `\n\nRelevant docs:\n${formatStructured(context.recentTickets)}`
        : "") +
      (billingNotes ? `\n\nBilling notes:\n${formatStructured(billingNotes)}` : ""),
  };
}

export function summarizeTrace(trace: Trace): string {
  const lines = [`run: ${trace.runId}`, `window: ${trace.windowId}`, "sources:"];

  lines.push(
    ...trace.sources.map((source) => {
      const dependencies = source.dependsOn.length
        ? `, dependsOn=${source.dependsOn.join("|")}`
        : "";
      const itemCount = source.itemCount !== undefined ? `, items=${source.itemCount}` : "";
      return `  - ${source.key}: ${source.kind} (${source.durationMs}ms, status=${source.status}${dependencies}${itemCount})`;
    }),
  );

  return lines.join("\n");
}
