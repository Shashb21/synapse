import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/support/session";

/**
 * The suite runs against its own dev server and database (KAN-19), never the
 * developer's: global.setup switches platform-wide AI settings and specs reset
 * workspaces, so a shared server would change the developer's data.
 *
 * - E2E_PORT: the port of the suite's server (default 43219; 43217 is `npm run dev`).
 * - E2E_DATABASE_URL: the suite's database (default synapse_e2e on the local
 *   Docker Postgres). In CI the workflow's DATABASE_URL (its Postgres service) is used.
 * - E2E_REUSE=1: reuse a server already running on E2E_PORT (you started it yourself).
 */
const port = process.env.E2E_PORT?.trim() || "43219";
const baseURL = `http://127.0.0.1:${port}`;
const databaseUrl =
  process.env.E2E_DATABASE_URL?.trim() ||
  (process.env.CI ? process.env.DATABASE_URL : undefined) ||
  "postgres://synapse:synapse@127.0.0.1:5433/synapse_e2e";
const databaseName = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//, "http://")).pathname.slice(1);
if (databaseName === "synapse" && process.env.E2E_ALLOW_DEV_DB !== "1") {
  throw new Error(
    "The e2e suite would run against the dev database (synapse). Set E2E_DATABASE_URL to a separate database (default synapse_e2e).",
  );
}

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npx next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    // Off by default, so the suite never attaches to a server on the dev database.
    reuseExistingServer: process.env.E2E_REUSE === "1",
    timeout: 120_000,
    env: {
      ...process.env,
      // Set here, so Next does not take the dev DATABASE_URL from .env.local.
      DATABASE_URL: databaseUrl,
      SYNAPSE_TEST_STUB_LLM: "1",
      // Never reach a real model from e2e, and keep every provider at "No key"
      // on a machine that has keys in its shell or .env.local (Next does not
      // override a variable that is already set, even when it is empty).
      XAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENROUTER_API_KEY: "",
    },
  },
  projects: [
    // Signs in (demo, development only) and opens a workspace; saves the cookies for everything else.
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
});
