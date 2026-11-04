import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "modules/*/test/**/*.test.ts", "modules/*/src/**/*.test.{ts,tsx}"],
    testTimeout: 30_000
  }
});
