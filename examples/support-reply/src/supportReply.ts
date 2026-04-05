import { type InferContext, type Trace } from "@budge/core";
import { z } from "zod";
import { budge } from "./budge.ts";
import { supportReplySources } from "./sourceRegistry.ts";

const supportReplyInputSchema = z.object({
  accountId: z.string(),
  transcript: z.string(),
});

const transcript = budge.input("transcript", { tags: ["restricted"] });

export const supportReplyWindow = budge.window({
  input: supportReplyInputSchema,
  id: "support_reply",
  sources: {
    transcript,
    account: supportReplySources.account,
    billingNotes: supportReplySources.billingNotes,
    recentTickets: supportReplySources.recentTickets,
  },

  derive: (ctx) => ({
    isEnterprise: ctx.account.plan === "enterprise",
    replyStyle: ctx.account.tier === "priority" ? ("concise" as const) : ("standard" as const),
    mentionsBilling: /\b(invoice|refund|charge|billing)\b/i.test(ctx.transcript),
  }),

  policies: {
    require: ["transcript", "account"],
    prefer: ["recentTickets", "billingNotes"],
    exclude: [
      (ctx) =>
        !ctx.mentionsBilling
          ? {
              source: "billingNotes",
              reason: "billing notes are excluded unless the transcript is billing-related",
            }
          : false,
    ],
    budget: 110,
  },

  system: (context) =>
    `You are a support engineer drafting a customer reply. Use a ${context.replyStyle} tone. ${
      context.isEnterprise
        ? "Prioritize urgency and ownership."
        : "Keep the reply practical and direct."
    }`,

  prompt: (context) =>
    `Customer message:\n${context.transcript}\n\nAccount:\n${String(context.account)}${
      context.recentTickets?.length
        ? `\n\nRecent tickets:\n${context.recentTickets.map((ticket) => ticket.content).join("\n")}`
        : ""
    }\n\nBilling notes:\n${context.billingNotes ? String(context.billingNotes) : "N/A"}`,
});

export type SupportReplyContext = InferContext<typeof supportReplyWindow>;

function formatTraceReason(reason: string): string {
  switch (reason) {
    case "chunk_trimmed_over_budget":
      return "chunk trimmed (over budget)";
    case "source_dropped_over_budget":
      return "source dropped (over budget)";
    default:
      return reason.replaceAll("_", " ");
  }
}

export function summarizeTrace(trace: Trace): string {
  const lines = [
    `run: ${trace.runId}`,
    `window: ${trace.windowId}`,
    `budget: ${trace.budget.used}/${trace.budget.max}`,
  ];

  if (trace.prompt) {
    lines.push(
      `prompt tokens: ${trace.prompt.totalTokens} (system: ${trace.prompt.systemTokens}, prompt: ${trace.prompt.promptTokens})`,
      `raw context tokens: ${trace.prompt.rawContextTokens}`,
      `included context tokens: ${trace.prompt.includedContextTokens}`,
      `compression vs resolved context: ${(trace.prompt.compressionRatio * 100).toFixed(1)}% reduction`,
      `compression vs included context: ${(trace.prompt.includedCompressionRatio * 100).toFixed(1)}% reduction`,
    );
  }

  lines.push("policies:");
  lines.push(
    ...trace.policies.map(
      (policy) => `  - ${policy.source}: ${policy.action} (${formatTraceReason(policy.reason)})`,
    ),
  );

  for (const source of trace.sources) {
    if (!source.items?.length) {
      continue;
    }

    const dropped = source.items.filter((chunk) => !chunk.included);
    if (dropped.length) {
      lines.push(`dropped chunks for ${source.key}:`);
      lines.push(
        ...dropped.map(
          (chunk) =>
            `  - ${formatTraceReason(chunk.reason ?? "dropped")} (score=${chunk.score ?? 0})`,
        ),
      );
    }
  }

  return lines.join("\n");
}
