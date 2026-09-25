import { test as setup } from "@playwright/test";
import { signInForSuite, STORAGE_STATE } from "./support/session";

/**
 * Every page and API sits behind the login proxy, so the suite signs in once
 * (demo sign-in, development only), opens a workspace and saves the cookies.
 * All other projects start from this storage state.
 */
setup("sign in and open a workspace", async ({ request }) => {
  await signInForSuite(request);
  await request.storageState({ path: STORAGE_STATE });
});
