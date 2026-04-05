import { z } from "zod";
import { db, vectorDb } from "./data.ts";
import { budge } from "./budge.ts";

const accountInputSchema = z.object({
  accountId: z.string(),
});

const transcriptInputSchema = z.object({
  transcript: z.string(),
});

const accountSourceSet = budge.sourceSet(({ source }) => {
  const account = source.value(accountInputSchema, {
    tags: ["internal"],
    async resolve({ input }) {
      return db.getAccount(input.accountId);
    },
  });

  const billingNotes = source.value(
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

const ticketSourceSet = budge.sourceSet(({ source }) => {
  const recentTickets = source.rag(
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

export const supportReplySources = budge.sources(accountSourceSet, ticketSourceSet);
