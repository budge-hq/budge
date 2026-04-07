import { z } from "zod";
import { db, vectorDb } from "./data.ts";
import { budge } from "./budge.ts";

export const accountSource = budge.source.value(
  z.object({
    accountId: z.string(),
  }),
  {
    tags: ["internal"],
    async resolve({ input }) {
      return db.getAccount(input.accountId);
    },
  },
);

export const billingNotesSource = budge.source.value(
  z.object({}),
  { account: accountSource },
  {
    tags: ["billing"],
    async resolve({ account }) {
      const notes = await db.getBillingNotes(account.id);
      return notes ?? "No billing notes available.";
    },
  },
);

export const recentTicketsSource = budge.source.rag(
  z.object({
    accountId: z.string(),
    transcript: z.string(),
  }),
  {
    tags: ["internal"],
    async resolve({ input }) {
      return vectorDb.searchTickets(input.accountId, input.transcript);
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
