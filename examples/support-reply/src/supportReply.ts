import { type InferContext, type Trace } from "@polo/core";
import { z } from "zod";
import { polo } from "./polo.ts";
import { supportReplySources } from "./sourceRegistry.ts";

const supportReplyInputSchema = z.object({
  accountId: z.string(),
  transcript: z.string(),
});

export const supportReply = polo.define(supportReplyInputSchema, {
  id: "support_reply",
  sources: {
    transcript: polo.source.fromInput("transcript", { tags: ["restricted"] }),
    account: supportReplySources.account,
    billingNotes: supportReplySources.billingNotes,
    recentTickets: supportReplySources.recentTickets,
  },

  derive: ({ context }) => ({
    isEnterprise: context.account.plan === "enterprise",
    replyStyle: context.account.tier === "priority" ? ("concise" as const) : ("standard" as const),
    mentionsBilling: /\b(invoice|refund|charge|billing)\b/i.test(context.transcript),
  }),

  policies: {
    require: ["transcript", "account"],
    prefer: ["recentTickets", "billingNotes"],
    exclude: [
      ({ context }) =>
        !context.mentionsBilling
          ? {
              source: "billingNotes",
              reason: "billing notes are excluded unless the transcript is billing-related",
            }
          : false,
    ],
    budget: 110,
  },

  template: ({ context }) => ({
    system: `You are a support engineer drafting a customer reply. Use a ${context.replyStyle} tone. ${
      context.isEnterprise
        ? "Prioritize urgency and ownership."
        : "Keep the reply practical and direct."
    }`,
    prompt: `Customer message:\n${context.transcript}\n\nAccount:\n${context.account}${
      context.recentTickets?.length
        ? `\n\nRecent tickets:\n${context.recentTickets.map((ticket) => ticket.content).join("\n")}`
        : ""
    }\n\nBilling notes:\n${context.billingNotes ?? "N/A"}`,
  }),
});

export type SupportReplyContext = InferContext<typeof supportReply>;

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
    `task: ${trace.taskId}`,
    `budget: ${trace.budget.used}/${trace.budget.max}`,
  ];

  if (trace.prompt) {
    lines.push(
      `prompt tokens: ${trace.prompt.totalTokens} (system: ${trace.prompt.systemTokens}, user: ${trace.prompt.promptTokens})`,
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
