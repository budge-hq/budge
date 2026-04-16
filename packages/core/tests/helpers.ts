import { emptyTrace } from "../src/trace.ts";
import { Effect, SubscriptionRef } from "effect";

export const makeTraceRef = (task: string) =>
  Effect.runPromise(SubscriptionRef.make(emptyTrace(task)));
