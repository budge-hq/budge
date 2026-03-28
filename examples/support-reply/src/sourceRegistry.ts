import { registerSources } from "@polo/core";
import { z } from "zod";
import { db, vectorDb } from "./data.ts";
import { polo } from "./polo.ts";

const accountInputSchema = z.object({
  accountId: z.string(),
});

const transcriptInputSchema = z.object({
  transcript: z.string(),
});

const accountSourceSet = polo.sourceSet((sources) => {
  const account = sources.value(accountInputSchema, {
    tags: ["internal"],
    async resolve({ input }) {
      return db.getAccount(input.accountId);
    },
  });

  const billingNotes = sources.value(
    accountInputSchema,
    { account },
    {
      tags: ["billing"],
      async resolve({ account }) {
        return db.getBillingNotes(account.id);
      },
    },
  );

  return {
    account,
    billingNotes,
  };
});

const ticketSourceSet = polo.sourceSet((sources) => {
  const recentTickets = sources.chunks(
    transcriptInputSchema,
    { account: accountSourceSet.account },
    {
      tags: ["internal"],
      async resolve({ input, account }) {
        return vectorDb.searchTickets(account.id, input.transcript);
      },
      normalize(item) {
        return {
          content: item.pageContent,
          score: item.relevanceScore,
          metadata: { ticketId: item.id },
        };
      },
    },
  );

  return { recentTickets };
});

export const supportReplySources = registerSources(accountSourceSet, ticketSourceSet);
