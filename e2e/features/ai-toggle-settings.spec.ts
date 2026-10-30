import { freshWorkspace } from "../support/session";
import { iegpAction, resetWorkspace, validateBandHigh } from "../support/synapse";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openRail } from "../support/rail";

/**
 * KAN-53: the Synapse admin turns AI on or off per section for every customer. Customers
 * have no AI switch; where a section is off they see its manual flow only.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

freshWorkspace({ name: "Per-section assistance", seed: async request => {
  await resetWorkspace(request);
  const gap = await iegpAction(request, { action: "create_gap", name: "Section assistance comparison", statement: "Comparative evidence is missing for the decision", domain: "comparative_effectiveness" });
  const id = String(gap.id);
  await iegpAction(request, { action: "validate_gap", gap_id: id, note: "Reviewed the missing comparative evidence" });
  await validateBandHigh(request, id, "The comparison is required for the decision");
  await iegpAction(request, { action: "complete_wizard", note: "The section-assistance inventory is reviewed" });
  await iegpAction(request, { action: "unlock_tactics", note: "The initial priority is confirmed" });
} });

async function control(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/control", { data });
  expect(res.ok(), `${JSON.stringify(data)} → ${res.status()} ${await res.text()}`).toBe(true);
}

async function openWorkspaceMenu(page: Page) {
  await expect(async () => {
    const menu = page.getByRole("menu");
    if (await menu.isVisible()) return;
    await page.getByTestId("workspace-tag").click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

test.afterAll(async ({ request }) => {
  await control(request, { action: "set_ai_enabled", enabled: true, rationale: "e2e restore" });
  await control(request, { action: "set_ai_sections", enabled: true });
});

test("customers have no AI switch, and the old endpoint refuses changes", async ({ page, request }) => {
  await page.goto("/?place=gaps");
  await openRail(page);
  await openWorkspaceMenu(page);
  await expect(page.getByRole("menu").getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("menu")).not.toContainText("AI assistance");
  await page.keyboard.press("Escape");

  const list = (await (await request.get("/api/workspaces")).json()) as { workspaces: { id: string }[] };
  const res = await request.post(`/api/workspaces/${list.workspaces[0]!.id}/ai`, { data: { enabled: false } });
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: string }).error).toMatch(/Synapse administrator/);
});

test("turning ingestion off removes Upload for customers; back on brings it back", async ({ page, request }) => {
  await control(request, { action: "set_ai_section", section: "ingestion", enabled: false });
  await page.goto("/?place=gaps");
  await openRail(page);
  const places = page.getByRole("navigation", { name: "Places" });
  await expect(places.getByRole("link", { name: /^upload/i })).toHaveCount(0);
  await page.goto("/?place=upload");
  await expect(page).toHaveURL(/place=gaps/);

  await control(request, { action: "set_ai_section", section: "ingestion", enabled: true });
  await page.goto("/?place=upload");
  await expect(page.getByRole("form", { name: "Add a source" })).toBeVisible();
});

test("turning ideation off hides only ideation's AI; other sections keep theirs", async ({ page, request }) => {
  await control(request, { action: "set_ai_section", section: "ideation", enabled: false });
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i })).toHaveCount(0);
  await expect(page.getByText("AI is off")).toHaveCount(0);
  // Prioritization is still on: its model placement is still offered.
  await page.goto("/?place=plan&setting=all");
  await expect(page.getByRole("heading", { name: /^prioritization matrix$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-suggest unvalidated", exact: true })).toBeVisible();

  await control(request, { action: "set_ai_section", section: "ideation", enabled: true });
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i }).first()).toBeVisible();
});

test("the master switch turns every section off", async ({ page, request }) => {
  await control(request, { action: "set_ai_enabled", enabled: false, rationale: "e2e" });
  await page.goto("/?place=plan&setting=all");
  await expect(page.getByRole("heading", { name: "Prioritization Matrix", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-suggest unvalidated", exact: true })).toHaveCount(0);
  // Validating priority does not place a gap on the selected matrix axes.
  // AI being off must keep the manual gap available regardless of placement.
  await expect(page.getByRole("button", { name: /^Section assistance comparison:/ })).toBeVisible();
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i })).toHaveCount(0);
  await control(request, { action: "set_ai_enabled", enabled: true, rationale: "e2e" });
});

test("admin switches announce saves and retain section preferences across master off and on", async ({ page, request }, testInfo) => {
  await control(request, { action: "set_ai_enabled", enabled: true });
  await control(request, { action: "set_ai_section", section: "ingestion", enabled: true });
  await page.goto("/admin/control");
  const panel = page.getByTestId("ai-switch-panel");
  const master = panel.getByTestId("ai-toggle");
  const ingestion = panel.getByTestId("ai-section-ingestion");
  const sectionFeedback = ingestion.locator("..").getByRole("status");
  const masterFeedback = master.locator("..").getByRole("status");

  // Hold a real POST so the pending state is observable before persistence.
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/control", async route => {
    if (route.request().postDataJSON()?.action === "set_ai_section") await delayed;
    await route.continue();
  });
  await ingestion.click();
  await expect(sectionFeedback).toHaveText("Saving AI for Ingestion…");
  await expect(ingestion).toBeDisabled();
  await expect(ingestion).toHaveAttribute("aria-checked", "true");
  release();
  await expect(sectionFeedback).toHaveText("AI for Ingestion is off. Saved.");
  await expect(ingestion).toHaveAttribute("aria-checked", "false");
  await page.unroute("**/api/control");

  await master.click();
  await expect(masterFeedback).toContainText("AI for all workspaces is off. Saved.");
  await expect(panel.getByTestId("ai-switch-state")).toContainText("AI is off");
  await expect(ingestion).toBeDisabled();
  await page.reload();
  await expect(master).toHaveAttribute("aria-checked", "false");
  await expect(ingestion).toHaveAttribute("aria-checked", "false");
  await expect(ingestion).toBeDisabled();

  await master.click();
  await expect(masterFeedback).toContainText("AI for all workspaces is on. Saved.");
  await expect(ingestion).toBeEnabled();
  await expect(ingestion).toHaveAttribute("aria-checked", "false");
  await ingestion.click();
  await expect(sectionFeedback).toHaveText("AI for Ingestion is on. Saved.");
  await page.reload();
  await expect(master).toHaveAttribute("aria-checked", "true");
  await expect(ingestion).toHaveAttribute("aria-checked", "true");

  // Capture real copy, wrapping and the 44px targets at both common sizes.
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await master.click();
    await expect(masterFeedback).toContainText("Saved.");
    await expect(ingestion).toBeDisabled();
    await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath(`ai-switch-feedback-${viewport.width}.png`) });
    await master.click();
    await expect(ingestion).toBeEnabled();
  }
});
