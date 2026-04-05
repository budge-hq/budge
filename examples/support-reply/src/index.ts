import { summarizeTrace, supportReplyWindow } from "./supportReply.ts";

const input = {
  accountId: "acc_123",
  transcript:
    "Our webhook deliveries have been timing out in production since yesterday's deploy. Can you help us figure out the safest next step?",
};

const { context, prompt, traces } = await supportReplyWindow(input);

console.log("=== Context Keys ===");
console.log(Object.keys(context));

if (prompt) {
  console.log("\n=== System Prompt ===");
  console.log(prompt.system);

  console.log("\n=== User Prompt ===");
  console.log(prompt.prompt);
}

console.log("\n=== Trace Summary ===");
console.log(summarizeTrace(traces));

console.log("\n=== Full Trace JSON ===");
console.log(JSON.stringify(traces, null, 2));
