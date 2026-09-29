import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createWorkspace, demoSignIn, selectWorkspace } from "../support/session";

/**
 * AI assistance in the workspace settings menu: the workspace owner turns AI
 * off for their workspace and the flow changes at once, with no reload. The
 * nav loses Upload and starts at Evidence Inventory, the Upload page shows Add gaps / Add
 * tactics, /sources goes to Evidence Inventory, and the AI buttons are gone. Turning it
 * back on brings the AI flow back. A member sees the switch read only.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial", timeout: 240_000 });

const unique = Math.random().toString(36).slice(2, 8);
const OWNER = { actor_name: `AI Owner ${unique}`, actor_function: "medical_affairs", email: `ai-owner-${unique}@demo.synapse.local` };
const MEMBER = { actor_name: `AI Member ${unique}`, actor_function: "heor", email: `ai-member-${unique}@demo.synapse.local` };
const WORKSPACE = `AI toggle ${unique}`;

let workspaceId = "";

async function ok(response: Awaited<ReturnType<APIRequestContext["post"]>>, what: string) {
  expect(response.ok(), `${what} → ${response.status()} ${await response.text()}`).toBe(true);
}

/** Opens the workspace tag's menu, retrying until the page has hydrated. */
async function openWorkspaceMenu(page: Page) {
  await expect(async () => {
    const menu = page.getByRole("menu");
    if (await menu.isVisible()) return;
    await page.getByTestId("workspace-tag").click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

function menuSwitch(page: Page) {
  return page.getByRole("menu").getByRole("switch", { name: "AI assistance" });
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Places" });
}

/** Flips the switch in the settings menu and confirms. */
async function flipFromMenu(page: Page, to: "on" | "off") {
  await openWorkspaceMenu(page);
  const toggle = menuSwitch(page);
  await expect(toggle).toHaveAttribute("aria-checked", to === "on" ? "false" : "true");
  await toggle.click();
  const confirm = page.getByTestId("workspace-ai-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(to === "off" ? /turn off ai assistance/i : /turn on ai assistance/i);
  await expect(confirm).toContainText(/other workspaces are not affected/i);
  // No rationale is asked for.
  await expect(confirm.getByRole("textbox")).toHaveCount(0);
  await confirm.getByRole("button", { name: to === "off" ? "Turn AI off" : "Turn AI on" }).click();
  await expect(confirm).toBeHidden();
}

async function expectAiButtonsGone(page: Page) {
  await page.goto("/ideation");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i })).toHaveCount(0);
  await page.goto("/?place=plan");
  await expect(nav(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /re-suggest/i })).toHaveCount(0);
  // The model's first placement ("Prioritize") gives way to saving the axes by hand.
  await expect(page.getByRole("button", { name: /^prioritize$/i })).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const request = context.request;
  // The member signs in once so the invite has a person to reach.
  await demoSignIn(request, MEMBER);
  await demoSignIn(request, OWNER);
  const workspace = await createWorkspace(request, WORKSPACE);
  workspaceId = workspace.id;
  await selectWorkspace(request, workspaceId);
  await ok(await request.post("/api/iegp", { data: { action: "load_demo" } }), "load demo");
  await ok(await request.post(`/api/workspaces/${workspaceId}/members`, { data: { email: MEMBER.email } }), "invite");
  await context.close();
});

test("the owner turns AI off from the settings menu and the flow changes at once", async ({ page }) => {
  await demoSignIn(page.request, OWNER);
  await selectWorkspace(page.request, workspaceId);

  await page.goto("/?place=upload");
  await expect(nav(page).getByRole("link", { name: "Upload" })).toBeVisible();
  await expect(page.getByTestId("ai-off-banner")).toHaveCount(0);

  await flipFromMenu(page, "off");

  // No reload: Upload leaves the nav (KAN-8: the manual flow starts on Evidence
  // Inventory) and the page in front of the user offers the manual start.
  await expect(nav(page).getByRole("link", { name: "Upload" })).toHaveCount(0);
  await expect(nav(page).getByRole("link").first()).toContainText("Evidence Inventory");
  await expect(page.getByRole("button", { name: /add gaps/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /add tactics/i }).first()).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByTestId("ai-off-banner")).toContainText(/off for this workspace/i);
  await openWorkspaceMenu(page);
  await expect(menuSwitch(page)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  await expectAiButtonsGone(page);

  // The server refuses AI work in this workspace too.
  const run = await page.request.post("/api/modules", { data: { stage: "S9", input: {} } });
  expect(run.status()).toBe(409);
  expect(((await run.json()) as { code?: string }).code).toBe("ai_off");
});

test("turning it back on from the settings page brings the AI flow back", async ({ page }) => {
  await demoSignIn(page.request, OWNER);
  await selectWorkspace(page.request, workspaceId);

  await page.goto(`/workspaces/${workspaceId}`);
  const toggle = page.getByTestId("workspace-ai-setting").getByRole("switch", { name: "AI assistance" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  // Keyboard operable: focus and press Space.
  await expect(async () => {
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("workspace-ai-confirm")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByTestId("workspace-ai-confirm").getByRole("button", { name: "Turn AI on" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("workspace-ai-state")).toHaveText(/AI assistance is on/);

  await page.goto("/?place=upload");
  await expect(nav(page).getByRole("link", { name: "Upload" })).toBeVisible();
  await expect(page.getByTestId("ai-off-banner")).toHaveCount(0);
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i }).first()).toBeVisible();
});

test("turning AI off while on Sources lands on Evidence Inventory", async ({ page }) => {
  await demoSignIn(page.request, OWNER);
  await selectWorkspace(page.request, workspaceId);

  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "Sources", exact: true })).toBeVisible();
  await flipFromMenu(page, "off");
  await expect(page).toHaveURL(/\/\?place=gaps$/);
  await expect(nav(page).getByRole("link", { name: "Upload" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /add open gap/i }).first()).toBeVisible();

  // And back on from the menu: the first place is Upload again, without a reload.
  await flipFromMenu(page, "on");
  await expect(nav(page).getByRole("link", { name: "Upload" })).toBeVisible();
});

test("a member sees the switch read only and cannot change it", async ({ page }) => {
  await demoSignIn(page.request, MEMBER);
  await selectWorkspace(page.request, workspaceId);

  await page.goto("/?place=upload");
  await openWorkspaceMenu(page);
  const toggle = menuSwitch(page);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("workspace-menu-ai-note")).toHaveText("Only the workspace owner can change this.");
  await toggle.click({ force: true });
  await expect(page.getByTestId("workspace-ai-confirm")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/workspaces/${workspaceId}`);
  const setting = page.getByTestId("workspace-ai-setting").getByRole("switch", { name: "AI assistance" });
  await expect(setting).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("workspace-ai-setting")).toContainText("Only the workspace owner can change this.");

  const res = await page.request.post(`/api/workspaces/${workspaceId}/ai`, { data: { enabled: false } });
  expect(res.status()).toBe(403);
  await page.goto("/?place=upload");
  await expect(nav(page).getByRole("link", { name: "Upload" })).toBeVisible();
});
