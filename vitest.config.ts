import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    environment: "node",
    env: { NODE_ENV: "test", LOG_LEVEL: "error", DEV_AUTH_ENABLED: "true" },
    // Each file boots an in-memory PostgreSQL; generous limits keep busy machines from flaking.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    // Each worker holds an in-memory PostgreSQL (~0.5 GB); keep local runs light.
    maxWorkers: process.env.CI ? 4 : 2,
  },
});
