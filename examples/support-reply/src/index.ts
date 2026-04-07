import { buildSupportReplyPrompt, summarizeTrace, supportReplyWindow } from "./supportReply.ts";

const result = await supportReplyWindow.resolve({
  input: {
    accountId: "acc_123",
    transcript:
      "Our webhook deliveries have been timing out in production since yesterday's deploy. Can you help us figure out the safest next step?",
  },
});

const prompt = buildSupportReplyPrompt(result.context);

console.log("=== Context ===");
console.log(JSON.stringify(result.context, null, 2));

console.log("\n=== Developer-Owned System ===");
console.log(prompt.system);

console.log("\n=== Developer-Owned Prompt ===");
console.log(prompt.prompt);

console.log("\n=== Trace Summary ===");
console.log(summarizeTrace(result.traces));

console.log("\n=== Full Trace JSON ===");
console.log(JSON.stringify(result.traces, null, 2));
