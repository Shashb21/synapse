import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Keep benchmark isolation and its existing I/O timeout consistent with
    // `npm run test:kan100` when running the complete suite.
    projects: [
      {
        extends: true,
        test: {
          name: "application",
          exclude: [...configDefaults.exclude, "tests/kan100-*.test.ts"],
        },
      },
      "./vitest.kan100.config.ts",
    ],
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/support/ai-on.ts"],
    fileParallelism: false,
    /** CI ingest/store tests exceed the default 5s under shared Postgres load. */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://synapse:synapse@127.0.0.1:5432/synapse_test",
      /** Vitest-only: agentic stages use local proposers (no live LLM). Not set in production. */
      SYNAPSE_TEST_STUB_LLM: "1",
      /**
       * Vitest-only: a route handler called directly with no session cookie acts
       * as the demo Medical Affairs user named in the body (see
       * modules/auth/api-guard.ts). Never set for the dev server or production.
       */
      SYNAPSE_TEST_ANON_API: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
