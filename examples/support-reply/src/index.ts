import { summarizeTrace, supportReplyWindow } from "./supportReply.ts";

const result = await supportReplyWindow.resolve({
  input: {
    accountId: "acc_123",
    transcript:
      "Our webhook deliveries have been timing out in production since yesterday's deploy. Can you help us figure out the safest next step?",
  },
});

if (result.system) {
  console.log("=== System Prompt ===");
  console.log(result.system);
}

if (result.prompt) {
  console.log("\n=== User Prompt ===");
  console.log(result.prompt);
}

console.log("\n=== Trace Summary ===");
console.log(summarizeTrace(result.trace));

console.log("\n=== Full Trace JSON ===");
console.log(JSON.stringify(result.trace, null, 2));
