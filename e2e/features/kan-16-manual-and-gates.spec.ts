import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ACTOR, iegpAction, planAction, previousGapId } from "../support/synapse";

/**
 * KAN-16 from a user's seat, with AI on:
 * - a blank plan starts by hand from the Upload screen, and the gap form asks for its domain;
 * - the server refuses "Continue to tactics" until every Open gap has a validated band;
 * - an excluded gap and a rejected mapping come back with a rationale;
 * - the timeline shows the date model estimates count from.
 */
test.describe.configure({ mode: "serial" });

async function setAi(request: APIRequestContext, enabled: boolean) {
  const res = await request.post("/api/control", {
    data: { action: "set_ai_enabled", enabled, rationale: enabled ? "e2e: AI on" : "e2e: AI off" },
  });
  expect(res.ok()).toBeTruthy();
}

async function openDialog(page: Page, name: string | RegExp) {
  const trigger = page.getByRole("button", { name }).first();
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

async function iegpRaw(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post("/api/iegp", { data: { ...ACTOR, ...body } });
  return { status: res.status(), body: (await res.json()) as { error?: string } };
}

test.describe("KAN-16: manual start, server gates, restore", () => {
  // Ids are never reissued after a reset (KAN-15): the specs use the ones the plan actually got.
  let firstGap = "";
  let secondGap = "";
  test.beforeAll(async ({ request }) => {
    await setAi(request, true);
    await iegpAction(request, { action: "reset" });
  });

  test("with AI on and nothing ingested, Upload offers Add gaps and Add tactics", async ({ page }) => {
    await page.goto("/?place=upload");
    const strip = page.getByTestId("manual-start-ai-on");
    await expect(strip).toBeVisible();
    await expect(strip.getByRole("heading", { name: "Start by hand" })).toBeVisible();
    await expect(strip.getByRole("button", { name: "Add gaps" })).toBeVisible();
    await expect(strip.getByRole("button", { name: "Add tactics" })).toBeVisible();
    // Upload is still there alongside it.
    await expect(page.getByRole("heading", { name: "Upload sources" })).toBeVisible();
  });

  test("adding a gap by hand asks for its domain instead of assuming one", async ({ page }) => {
    await page.goto("/?place=upload");
    const dialog = await openDialog(page, "Add gaps");
    await dialog.locator('input[name="name"]').fill("Persistence versus standard of care");
    await dialog.locator('textarea[name="statement"]').fill("No persistence evidence versus standard of care in routine practice.");
    const domain = dialog.locator('select[name="domain"]');
    await expect(domain).toHaveValue("");
    await dialog.getByRole("button", { name: "Add gap" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(/Fill in "Domain", then try again\./);
    await domain.selectOption("comparative_effectiveness");
    await dialog.getByRole("button", { name: "Add gap" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("manual-start-ai-on")).toContainText("1 gap and 0 tactics so far.");
  });

  test("the server refuses Continue to tactics until every Open gap has a validated band", async ({ request }) => {
    const created = await iegpAction(request, {
      action: "create_gap",
      statement: "No caregiver burden evidence for the EU5 HTA submission.",
      domain: "unmet_need",
    });
    secondGap = String(created.id);
    // Ids come from one counter in order, so the gap added by hand just before is the previous number.
    firstGap = previousGapId(secondGap);
    for (const gap_id of [firstGap, secondGap]) await iegpAction(request, { action: "validate_gap", gap_id });
    await iegpAction(request, { action: "complete_wizard" });

    const early = await iegpRaw(request, { action: "unlock_tactics" });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/0 of 2 validated, 2 to go/);

    await planAction(request, { action: "validate_band", gap_id: firstGap, band: "high", rationale: "Blocks the HTA dossier" });
    const half = await iegpRaw(request, { action: "unlock_tactics" });
    expect(half.status).toBe(400);
    expect(half.body.error).toMatch(/1 of 2 validated, 1 to go/);

    await planAction(request, { action: "validate_band", gap_id: secondGap, band: "low", rationale: "Next cycle is fine" });
    expect((await iegpRaw(request, { action: "unlock_tactics" })).status).toBe(200);
  });

  test("an excluded gap is listed under Set aside and restored with a rationale", async ({ page }) => {
    await page.goto(`/gaps/${secondGap}`);
    const exclude = await openDialog(page, "Exclude gap");
    await expect(exclude.locator('select[name="exclusion_reason"]')).toHaveValue("");
    await exclude.locator('select[name="exclusion_reason"]').selectOption("outside_scope");
    await exclude.locator('textarea[name="note"]').fill("Belongs to the caregiver programme");
    await exclude.getByRole("button", { name: "Exclude" }).click();
    await expect(exclude).toBeHidden();
    await expect(page.getByTestId("gap-excluded")).toContainText("Outside IEGP scope");

    await page.goto("/?place=gaps");
    const setAside = page.getByTestId("set-aside-gaps");
    await expect(setAside).toContainText("Set aside (1)");
    await expect(setAside).toContainText("Belongs to the caregiver programme");

    const restore = await openDialog(page, "Restore gap");
    await restore.getByRole("button", { name: "Restore" }).click();
    await expect(restore.getByRole("alert")).toHaveText(/Fill in "Why restore it\?", then try again\./);
    await restore.locator('textarea[name="note"]').fill("The caregiver programme folded into this plan");
    await restore.getByRole("button", { name: "Restore" }).click();
    await expect(restore).toBeHidden();
    await expect(page.getByTestId("set-aside-gaps")).toHaveCount(0);
  });

  test("a rejected mapping stays listed and can be lifted", async ({ page, request }) => {
    const tactic = await iegpAction(request, {
      action: "record_missed_tactic",
      name: "Claims persistence study",
      type: "rwe_study",
      status: "ongoing",
      evidence_question: "What is 12-month persistence?",
    });
    await iegpAction(request, { action: "reject_mapping", gap_id: firstGap, tactic_id: String(tactic.id), rationale: "Wrong population" });
    await page.goto("/mappings");
    const section = page.getByTestId("rejected-mappings");
    await expect(section).toContainText("Rejected mappings (1)");
    await expect(section).toContainText("Wrong population");
    const dialog = await openDialog(page, /^Restore$/);
    await dialog.locator('textarea[name="note"]').fill("Population matches after the protocol amendment");
    await dialog.getByRole("button", { name: "Lift rejection" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("rejected-mappings")).toContainText("Rejected mappings (0)");
  });

  test("the timeline shows the plan start date, prefilled with today", async ({ page }) => {
    await page.goto("/timeline");
    const anchor = page.getByTestId("timeline-anchor").first();
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  });
});
