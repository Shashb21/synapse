import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/support/session";

/** E2E_PORT runs the suite against its own dev server (e.g. several worktrees at once). */
const port = process.env.E2E_PORT?.trim() || "43217";
const baseURL = `http://127.0.0.1:${port}`;

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
    command: port === "43217" ? "npm run dev" : `npx next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      ...process.env,
      SYNAPSE_TEST_STUB_LLM: "1",
      // Never reach a real model from e2e, and keep "no provider connected" true
      // on a machine that has keys in its shell or .env.local (Next does not
      // override a variable that is already set, even when it is empty).
      XAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
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
