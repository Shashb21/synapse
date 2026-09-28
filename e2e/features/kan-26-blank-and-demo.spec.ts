import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * KAN-26: a new workspace starts blank unless you ask for the demo. Creating
 * one offers "Start blank" (default) or "Start with demo data (Velmara)"; a
 * demo workspace is badged Demo in the list and the workspace tag; the owner
 * can load the demo into a workspace or reset it to blank from settings.
 * Each test signs in as a fresh demo user, so it owns what it creates.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const unique = () => Math.random().toString(36).slice(2, 8);

async function refill(field: Locator, value: string) {
  await field.fill("");
  await field.fill(value);
}

/** Fills until the page has hydrated and the button enables. */
async function fillUntilEnabled(fill: () => Promise<void>, button: Locator) {
  await expect(async () => {
    await fill();
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
}

async function signIn(page: Page, name: string, email: string) {
  await page.goto("/login");
  const form = page.getByRole("form", { name: "Demo sign-in" });
  const submit = form.getByRole("button", { name: /continue as a demo user/i });
  await fillUntilEnabled(async () => {
    await refill(form.getByLabel("Your name"), name);
    await refill(form.getByLabel(/Email/), email);
  }, submit);
  await submit.click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 60_000 });
}

async function createWorkspace(page: Page, name: string, start: "blank" | "demo") {
  const form = page.getByRole("form", { name: "Create a workspace" });
  const submit = form.getByRole("button", { name: "Create workspace" });
  const blank = form.getByRole("radio", { name: "Start blank" });
  // Blank is the default choice.
  await expect(blank).toBeChecked();
  await fillUntilEnabled(() => refill(form.getByLabel("Workspace name"), name), submit);
  if (start === "demo") {
    await form.getByRole("radio", { name: "Start with demo data (Velmara)" }).check();
    await expect(blank).not.toBeChecked();
  }
  await submit.click();
}

async function openSettings(page: Page, name: string) {
  await page.goto("/workspaces");
  await page.getByRole("link", { name: `Settings for ${name}` }).click();
  await expect(page.getByRole("heading", { name: "Contents" })).toBeVisible({ timeout: 60_000 });
}

/** Presses a button until its dialog opens (a click before hydration does nothing). */
async function openDialog(page: Page, button: string) {
  await expect(async () => {
    await page.getByRole("button", { name: button, exact: true }).click({ timeout: 5_000 });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  return page.getByRole("dialog");
}

async function planState(page: Page) {
  const res = await page.request.get("/api/plan");
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

test("a new workspace starts blank: no Velmara, no objectives, no key decisions", async ({ page }) => {
  const id = unique();
  await signIn(page, `Blank Tester ${id}`, `kan26.blank.${id}@example.com`);
  const name = `Blank ${id}`;
  await createWorkspace(page, name, "blank");
  await expect(page).toHaveURL(/\/setup\?new=1/, { timeout: 90_000 });
  // The setup wizard starts empty: nothing prefilled from a demo.
  await expect(async () => {
    await page.getByRole("button", { name: /^get started$/i }).click({ timeout: 5_000 });
    await expect(page.getByTestId("setup-step-asset")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByLabel(/Asset \/ brand name/)).toHaveValue("");

  await page.goto("/timeline");
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(name);
  await expect(page.getByTestId("workspace-tag-demo")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/velmara/i);

  await page.goto("/?place=upload");
  await expect(page.getByRole("heading", { name: "Demo source files" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/velmara/i);

  await page.goto("/workspaces");
  const row = page.getByTestId("workspace-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("demo-badge")).toHaveCount(0);
});

test("start with demo data: the Velmara demo loads and the workspace is badged Demo", async ({ page }) => {
  const id = unique();
  await signIn(page, `Demo Tester ${id}`, `kan26.demo.${id}@example.com`);
  const name = `Demo ${id}`;
  await createWorkspace(page, name, "demo");
  // A demo workspace is already set up, so it opens on the plan, not the wizard.
  await expect(page).not.toHaveURL(/\/setup/, { timeout: 90_000 });
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(name, { timeout: 60_000 });
  await expect(page.getByTestId("workspace-tag-demo")).toHaveText("Demo");

  // The seed's gaps are there, ready for testing.
  await page.goto("/gaps");
  await expect(page.getByText(/elderly/i).first()).toBeVisible({ timeout: 60_000 });

  await page.goto("/workspaces");
  const row = page.getByTestId("workspace-row").filter({ hasText: name });
  await expect(row.getByTestId("demo-badge")).toHaveText("Demo");
});

test("the owner can load demo data and reset to blank from settings, each after a confirm", async ({ page }) => {
  const id = unique();
  await signIn(page, `Settings Tester ${id}`, `kan26.settings.${id}@example.com`);
  const name = `Switch ${id}`;
  await createWorkspace(page, name, "blank");
  await expect(page).toHaveURL(/\/setup\?new=1/, { timeout: 90_000 });

  await openSettings(page, name);
  await expect(page.getByTestId("settings-demo-badge")).toHaveCount(0);

  // Cancel leaves everything as it was.
  let dialog = await openDialog(page, "Load demo data");
  await expect(dialog).toContainText("Replace everything with the Velmara demo?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("settings-demo-badge")).toHaveCount(0);

  dialog = await openDialog(page, "Load demo data");
  await dialog.getByRole("button", { name: "Replace with demo data" }).click();
  await expect(page.getByRole("status")).toContainText("Demo data loaded", { timeout: 60_000 });
  await expect(page.getByTestId("settings-demo-badge")).toHaveText("Demo");
  const demo = await planState(page);
  expect(JSON.stringify(demo)).toMatch(/velmara/i);

  await page.goto("/workspaces");
  await expect(page.getByTestId("workspace-row").filter({ hasText: name }).getByTestId("demo-badge")).toHaveText("Demo");

  await openSettings(page, name);
  dialog = await openDialog(page, "Reset to blank");
  await expect(dialog).toContainText("Reset this workspace to blank?");
  await dialog.getByRole("button", { name: "Reset to blank" }).click();
  await expect(page.getByRole("status")).toContainText("reset to blank", { timeout: 60_000 });
  await expect(page.getByTestId("settings-demo-badge")).toHaveCount(0);
  const blank = await planState(page);
  expect(JSON.stringify(blank)).not.toMatch(/velmara/i);

  await page.goto("/workspaces");
  await expect(page.getByTestId("workspace-row").filter({ hasText: name }).getByTestId("demo-badge")).toHaveCount(0);
});

test("a member who is not the owner sees no load-demo or reset actions and is refused by the API", async ({ page }) => {
  const id = unique();
  const owner = `kan26.owner.${id}@example.com`;
  const member = `kan26.member.${id}@example.com`;
  await signIn(page, `Owner ${id}`, owner);
  const name = `Shared ${id}`;
  await createWorkspace(page, name, "demo");
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(name, { timeout: 90_000 });
  const created = await page.request.get("/api/workspaces");
  const ws = ((await created.json()) as { workspaces: { id: string; name: string }[] }).workspaces.find((w) => w.name === name)!;
  const invite = await page.request.post(`/api/workspaces/${ws.id}/members`, { data: { email: member } });
  expect(invite.ok(), await invite.text()).toBe(true);

  await page.request.post("/api/auth/logout", { data: {} });
  await signIn(page, `Member ${id}`, member);
  await page.getByRole("link", { name: `Settings for ${name}` }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("demo-badge")).toHaveText("Demo");
  await expect(page.getByRole("button", { name: "Load demo data" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset to blank" })).toHaveCount(0);

  const select = await page.request.post("/api/workspaces/select", { data: { workspace_id: ws.id } });
  expect(select.ok()).toBe(true);
  for (const action of ["reset", "load_demo"]) {
    const refused = await page.request.post("/api/iegp", { data: { action } });
    expect(refused.status(), action).toBe(403);
  }
});
