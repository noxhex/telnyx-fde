import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "functions/*/test/**/*.test.ts",
      "assistant/test/**/*.test.ts",
      "scripts/test/**/*.test.ts",
    ],
  },
});
