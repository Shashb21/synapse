import { test as setup } from "@playwright/test";
import { signInForSuite, STORAGE_STATE } from "./support/session";

/**
 * Every page and API sits behind the login proxy, so the suite signs in once
 * (demo sign-in, development only), opens a workspace and saves the cookies.
 * All other projects start from this storage state.
 */
setup("sign in and open a workspace", async ({ request }) => {
  await signInForSuite(request);
  // Every AI section starts off (KAN-53); the suite runs with AI on, and AI-off specs turn it off.
  for (const data of [
    { action: "set_ai_enabled", enabled: true, rationale: "e2e suite" },
    { action: "set_ai_sections", enabled: true },
  ]) {
    const res = await request.post("/api/control", { data });
    if (!res.ok()) throw new Error(`AI setup failed: ${res.status()} ${await res.text()}`);
  }
  await request.storageState({ path: STORAGE_STATE });
});
