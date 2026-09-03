import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    // Several integration files spawn Git/Node processes and loopback HTTP
    // servers. More than two file workers can exhaust Windows loopback/process
    // resources and reset an otherwise healthy MCP request under full-suite load.
    maxWorkers: 2,
  },
});
