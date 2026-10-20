import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction, planAction } from "../support/synapse";

test.describe("KAN-118 inventory readiness", () => {
  freshWorkspace({ name: "KAN-118" });
  test("new unresolved evidence leaves validated priority work available", async ({ page, request }) => {
    await iegpAction(request, { action: "reset" });
    const first = await iegpAction(request, { action: "create_gap", statement: "Missing comparative survival evidence", domain: "comparative_effectiveness" });
    const gap_id = String(first.id);
    await iegpAction(request, { action: "validate_gap", gap_id });
    await iegpAction(request, { action: "complete_wizard" });
    await planAction(request, { action: "validate_band", gap_id, band: "high", rationale: "Needed for submission" });
    await iegpAction(request, { action: "unlock_tactics" });
    await iegpAction(request, { action: "create_gap", statement: "New evidence identifies an unresolved safety question", domain: "unmet_need" });
    await page.goto("/?place=gaps");
    const readiness = page.getByRole("region", { name: "Inventory review readiness" });
    await expect(readiness).toContainText("2 live gaps · 1 gaps needing attention");
    await expect(readiness).toContainText("1 gaps with unconfirmed status");
    await expect(readiness).toContainText("Previously unlocked stages remain available for eligible work.");
    const strip = page.getByRole("status", { name: "Prep readiness" });
    await expect(strip).toContainText("Inventory review: 1 gaps needing attention");
    await expect(strip).toContainText("1 of 2 Open gaps with validated priority · Tactics open");
    await page.goto("/?place=plan");
    await expect(page.getByText("1 of 2 Open gaps with priority confirmed across all settings").first()).toBeVisible();
    await expect(page.getByText("Tactics is unlocked. You can keep adjusting priorities here.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Waiting on Gaps" })).toHaveCount(0);
    await page.goto("/?place=tactics");
    await expect(page.getByRole("heading", { name: "Tactic Ideation", exact: true })).toBeVisible();
    await expect(page.getByText("Missing comparative survival evidence", { exact: true }).first()).toBeVisible();
  });
});
