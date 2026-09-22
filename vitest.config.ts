import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://synapse:synapse@127.0.0.1:5432/synapse_test",
      /** Vitest-only: agentic stages use local proposers (no live LLM). Not set in production. */
      SYNAPSE_TEST_STUB_LLM: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
