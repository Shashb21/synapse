import { expect, test, type Page } from "@playwright/test";
import { demoSignIn, selectWorkspace } from "../support/session";
import { iegpAction, resetWorkspace } from "../support/synapse";

/** Real shared-cookie tabs must never replace a workspace other than the confirmed target. */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 180_000 });

const RECOVERY = "The selected workspace changed. Reopen the intended workspace and try again. No contents were changed.";
const ACTIONS = [
  { action: "reset", open: "Reset to blank", confirm: "Reset to blank" },
  { action: "load_demo", open: "Load demo data", confirm: "Replace with demo data" },
] as const;

/** Seeds distinct owned workspaces with notes for persisted-content comparisons. */
async function seed(page: Page) {
  const unique = crypto.randomUUID();
  await demoSignIn(page.request, { actor_name: "Workspace race", email: `kan162.${unique}@example.com` });
  const workspaces: { id: string; name: string }[] = [];
  for (const label of ["A", "B"]) {
    const response = await page.request.post("/api/workspaces", { data: { name: `KAN162 ${label} ${unique}`, start: label === "A" ? "demo" : "blank" } });
    expect(response.ok(), await response.text()).toBe(true);
    const { workspace } = await response.json() as { workspace: { id: string; name: string } };
    workspaces.push(workspace);
    // Persist blank state before /api/plan fans out into parallel readers;
    // otherwise its lazy first-read initialization can race itself.
    if (label === "B") await iegpAction(page.request, { action: "reset", expected_workspace_id: workspace.id });
    const note = await page.request.post("/api/room", { data: { op: "note", slide_id: "context", notes: `Preserve ${label} ${unique}` } });
    expect(note.ok(), await note.text()).toBe(true);
  }
  return { a: workspaces[0]!, b: workspaces[1]! };
}

/** Reads persisted contents and demo metadata after explicitly selecting each workspace. */
async function snapshot(page: Page, id: string) {
  await selectWorkspace(page.request, id);
  const listing = await page.request.get("/api/workspaces");
  expect(listing.ok()).toBe(true);
  const body = await listing.json() as { current_id: string; workspaces: { id: string; demo: boolean }[] };
  expect(body.current_id).toBe(id);
  const plan = await page.request.get("/api/plan");
  const room = await page.request.get("/api/room?notes=1");
  expect(plan.ok(), await plan.text()).toBe(true);
  expect(room.ok(), await room.text()).toBe(true);
  return { demo: body.workspaces.find(workspace => workspace.id === id)!.demo, plan: await plan.json(), notes: (await room.json()).notes };
}

/** Retries only opening the dialog, because early clicks can precede hydration. */
async function openDialog(page: Page, button: string) {
  await expect(async () => {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return page.getByRole("dialog");
}

for (const operation of ACTIONS) {
  for (const nonCurrent of [false, true]) {
    test(`${operation.action}: ${nonCurrent ? "non-current card select race" : "stale current confirmation"} preserves both workspaces`, async ({ page, context }) => {
      const { a, b } = await seed(page);
      const tabB = await context.newPage();
      const beforeA = await snapshot(page, a.id);
      const beforeB = await snapshot(page, b.id);
      await selectWorkspace(page.request, nonCurrent ? b.id : a.id);
      await page.goto(`/workspaces/${a.id}`);
      await expect(page.getByRole("heading", { name: "Contents" })).toBeVisible();
      const dialog = await openDialog(page, operation.open);
      let release: (() => void) | undefined;
      if (nonCurrent) {
        // The UI's select(A) has completed when it sends the replacement. Hold that
        // real request until tab B has changed the shared session selection.
        const held = new Promise<void>(resolve => { release = resolve; });
        let intercepted!: () => void;
        const arrived = new Promise<void>(resolve => { intercepted = resolve; });
        await page.route("**/api/iegp", async route => {
          expect(route.request().postDataJSON()).toMatchObject({ action: operation.action, expected_workspace_id: a.id });
          intercepted();
          await held;
          await route.continue();
        });
        await dialog.getByRole("button", { name: operation.confirm, exact: true }).click();
        await arrived;
      }
      await selectWorkspace(tabB.request, b.id);
      const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/iegp") && response.request().method() === "POST");
      if (release) release();
      else await dialog.getByRole("button", { name: operation.confirm, exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ code: "workspace_mismatch", error: RECOVERY });
      expect(response.request().postDataJSON()).toMatchObject({ expected_workspace_id: a.id });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(RECOVERY);
      await expect(dialog.getByRole("button", { name: operation.confirm, exact: true })).toBeEnabled();
      expect(await snapshot(page, a.id)).toEqual(beforeA);
      expect(await snapshot(page, b.id)).toEqual(beforeB);
      // A rejection retains the opening target even after a subsequent retry.
      const retry = page.waitForResponse(response => response.url().endsWith("/api/iegp"));
      await dialog.getByRole("button", { name: operation.confirm, exact: true }).click();
      const retried = await retry;
      expect(retried.request().postDataJSON()).toMatchObject({ expected_workspace_id: a.id });
      if (!nonCurrent) expect(retried.status()).toBe(409);
      await tabB.close();
    });
  }
}

test("demo reset bar keeps its dialog and URL on stale selection, then succeeds for its matching target", async ({ page, context }) => {
  const { a, b } = await seed(page);
  await selectWorkspace(page.request, a.id);
  const customGap = await iegpAction(page.request, {
    action: "create_gap", name: "Remove on matching demo reset",
    statement: "A custom gap that must survive rejection and disappear after successful replacement",
    domain: "comparative_effectiveness",
  });
  const beforeA = await snapshot(page, a.id);
  const beforeB = await snapshot(page, b.id);
  await selectWorkspace(page.request, a.id);
  await page.goto("/timeline");
  const dialog = await openDialog(page, "Reset demo");
  await expect(dialog).toContainText(a.name);
  const originalURL = page.url();
  const tabB = await context.newPage();
  await selectWorkspace(tabB.request, b.id);
  const rejected = page.waitForResponse(response => response.url().endsWith("/api/iegp"));
  await dialog.getByRole("button", { name: "Reset demo", exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toHaveText(RECOVERY);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(originalURL);
  expect(await snapshot(page, b.id)).toEqual(beforeB);
  expect(await snapshot(page, a.id)).toEqual(beforeA);
  const accepted = page.waitForResponse(response => response.url().endsWith("/api/iegp"));
  await dialog.getByRole("button", { name: "Reset demo", exact: true }).click();
  expect((await accepted).status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(a.name);
  await selectWorkspace(page.request, a.id);
  const removed = await page.request.get(`/api/gaps/${String(customGap.id)}`);
  expect(removed.status()).toBe(404);
  expect(await snapshot(page, b.id)).toEqual(beforeB);
  await tabB.close();
});

test("shared replacement fixtures bind the selected workspace and preserve explicit stale IDs", async ({ page }) => {
  const { a, b } = await seed(page);
  await selectWorkspace(page.request, a.id);
  await resetWorkspace(page.request);
  await expect(iegpAction(page.request, { action: "reset", expected_workspace_id: b.id })).rejects.toThrow("409");
  const state = await snapshot(page, a.id);
  expect(state.demo).toBe(true);
});
