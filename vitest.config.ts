import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    environment: "node",
    env: { NODE_ENV: "test", LOG_LEVEL: "error", DEV_AUTH_ENABLED: "true" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
