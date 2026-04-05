import { summarizeTrace, supportReplyWindow } from "./supportReply.ts";

const input = {
  accountId: "acc_123",
  transcript:
    "Our webhook deliveries have been timing out in production since yesterday's deploy. Can you help us figure out the safest next step?",
};

const { context, system, prompt, trace } = await supportReplyWindow(input);

console.log("=== Context Keys ===");
console.log(Object.keys(context));

if (system) {
  console.log("\n=== System Prompt ===");
  console.log(system);
}

if (prompt) {
  console.log("\n=== User Prompt ===");
  console.log(prompt);
}

console.log("\n=== Trace Summary ===");
console.log(summarizeTrace(trace));

console.log("\n=== Full Trace JSON ===");
console.log(JSON.stringify(trace, null, 2));
