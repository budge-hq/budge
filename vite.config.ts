import { defineConfig } from "vite-plus";

const hiddenAgentPaths = [".agents/**", ".claude/**"];

export default defineConfig({
  fmt: {
    ignorePatterns: hiddenAgentPaths,
  },
  lint: {
    ignorePatterns: hiddenAgentPaths,
  },
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/.agents/**", "**/.claude/**"],
  },
});
