/** An accepted design edit retains the old judgement until a deliberate human reassessment. */
import { expect, test } from "@playwright/test";
import { iegpAction, resetWorkspace } from "../support/synapse";
import { freshWorkspace } from "../support/session";

freshWorkspace({ name: "Assessment freshness" });

test("KAN-144 exposes the outdated reason and preserves judgement through keyboard reassessment", async ({ page, request }, testInfo) => {
  await resetWorkspace(request);
  const gap = await iegpAction(request, { action: "create_gap", name: "Freshness decision", domain: "comparative_effectiveness", statement: "Comparative evidence for the current decision", rationale: "Freshness browser fixture" });
  const tactic = await iegpAction(request, { action: "record_missed_tactic", name: "Freshness protocol", type: "rwe_study", evidence_question: "Adult comparative outcomes", comparator: "Placebo", status: "ongoing", rationale: "Freshness browser fixture" });
  await iegpAction(request, { action: "assign_tactic", gap_id: gap.id, tactic_id: tactic.id, overall: "partial", dimensions: JSON.stringify({ comparator: "no" }), rationale: "Original human judgement before protocol amendment" });
  await iegpAction(request, { action: "modify_tactic", tactic_id: tactic.id, comparator: "Active comparator", rationale: "Accepted protocol amendment" });
  await page.goto(`/gaps/${gap.id}`);
  const details = page.getByTestId("relationship-fit");
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(details.getByText("Outdated — explicit reassessment required", { exact: false })).toBeVisible();
  await expect(details.getByText("Tactic design changed: comparator.", { exact: true })).toBeVisible();
  await expect(page.getByText("Original human judgement before protocol amendment", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("kan144-outdated-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("kan144-outdated-mobile.png"), fullPage: true });
  const trigger = page.getByRole("button", { name: "Change overall coverage", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Overall", exact: true }).selectOption("partial");
  await dialog.getByLabel("Your rationale (required)").fill("Explicitly reassessed the current amended protocol");
  await dialog.getByRole("button", { name: "Change overall coverage", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(async () => {
    const record = await (await request.get(`/api/gaps/${gap.id}`)).json();
    expect(record.coverages[0].fit).toMatchObject({ overall: "partial", stale: false, confirmation: { locked: true } });
  }).toPass();
  await expect(details.getByText("Outdated — explicit reassessment required", { exact: false })).toHaveCount(0);
});
