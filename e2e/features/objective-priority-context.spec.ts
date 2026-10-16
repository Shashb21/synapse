import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction, planAction, planActionExpectingError, planState } from "../support/synapse";

test.use({ actionTimeout: 10_000 });

let visibleGap = "", hiddenGap = "", tacticId = "";
freshWorkspace({ name: "KAN130 shared objective context", seed: async request => {
  await iegpAction(request, { action: "save_product_setup", mark_complete: true, reason: "Record the initial committee context", context: {
    asset_name: "Deadline study", therapeutic_area: "Immunology", indications: [{ name: "Psoriasis", status: "current" }],
    lifecycle_stage: "growth", markets: ["US"], plan_owner: "Evidence lead", sponsoring_function: "Medical Affairs",
    stakeholders: [{ function: "HEOR", lead: "Evidence lead" }], treatment_settings: ["1L", "2L"],
    objectives: [{ name: "Committee submission", key_decision: "Committee meeting", decision_date: "2028-06-30" }],
  } });
  for (const setting of ["1L", "2L"]) {
    const created = await iegpAction(request, { action: "create_gap", name: `${setting} comparative evidence`, statement: `Comparative evidence is missing for ${setting}.`, domain: "comparative_effectiveness", settings: setting });
    const id = String(created.id);
    if (setting === "1L") visibleGap = id; else hiddenGap = id;
    await iegpAction(request, { action: "validate_gap", gap_id: id });
    await planAction(request, { action: "set_placement", gap_id: id, band: "high", validate: true, axis_scores: { decision_impact: setting === "1L" ? 80 : 90, time_pressure: 75 }, rationale: "Evidence blocks the committee decision", reason: "Initial priority review" });
  }
  await iegpAction(request, { action: "complete_wizard", note: "Inventory reviewed" });
  await iegpAction(request, { action: "unlock_tactics", note: "All initial priorities confirmed" });
  const added = await planAction(request, { action: "add_proposal", gap_id: visibleGap, name: "Existing committee study", type: "rwe_study", evidence_question: "What is comparative effectiveness?", rationale: "Keep planned evidence work" });
  const accepted = await planAction(request, { action: "decide_proposal", id: (added.proposal as { id: string }).id, decision: "accept", rationale: "Accepted before context changed" });
  tacticId = String(accepted.tactic_id);
} });

test("edits a shared deadline without references, previews a hidden gap and reconfirms without losing prior work", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(`/gaps/${visibleGap}`);
  const context = page.locator("dl").filter({ has: page.getByText("Evidence needed by", { exact: true }) }).first();
  await expect(context).toContainText("Unknown");
  await expect(context).toContainText("2028-06-30");
  await page.goto("/?place=plan&setting=1L");
  await expect(page.getByRole("button", { name: /^1L comparative evidence: High, priority confirmed/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^2L comparative evidence:/ })).toHaveCount(0);

  await page.goto("/setup");
  await page.getByRole("button", { name: /Objectives & decisions$/ }).click();
  await expect(page.getByText(/papers due 10 June/)).toBeVisible();
  await page.getByLabel(/^Evidence needed by/).fill("2028-06-10");
  const impact = page.getByRole("region", { name: "Objective change impact" });
  await expect(impact).toContainText("2 linked Open gaps");
  await expect(impact).toContainText("2L comparative evidence");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("setup-wizard").getByRole("alert")).toContainText("meaningful reason");
  await expect(page.getByLabel(/^Evidence needed by/)).toHaveValue("2028-06-10");
  await page.getByLabel("Reason for objective changes").fill("Committee papers are needed before the meeting");

  // A failed save retains the entered context, reason and current selection.
  await page.route("**/api/iegp", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Save failed; please retry" }) }), { times: 1 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("setup-wizard").getByRole("alert")).toContainText("Save failed");
  await expect(page.getByLabel("Reason for objective changes")).toHaveValue("Committee papers are needed before the meeting");
  await expect(page.getByLabel(/^Evidence needed by/)).toHaveValue("2028-06-10");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("setup-step-landscape")).toBeVisible();
  const after = (await planState(request)).placements;
  for (const id of [visibleGap, hiddenGap]) expect(after.find(p => p.gap_id === id)).toMatchObject({ validated: false, needs_review: true, band: "high", rationale: "Evidence blocks the committee decision" });
  const blocked = await planActionExpectingError(request, { action: "add_proposal", gap_id: visibleGap, name: "Premature new idea", type: "rwe_study", evidence_question: "New evidence?", rationale: "Try before reconfirmation" });
  expect(blocked.status).toBe(400);
  expect(blocked.error).toMatch(/human-validated High/);
  await page.goto(`/tactics/${tacticId}`);
  await expect(page.getByText("Existing committee study", { exact: true }).first()).toBeVisible();
  await page.goto(`/gaps/${visibleGap}`);
  await expect(page.getByTestId("gap-priority")).toContainText("Review changed context and reconfirm");
  await expect(page.getByTestId("gap-ideas")).toContainText("Existing committee study");
  await expect(page.getByTestId("entity-history")).toContainText("Shared context");
  await expect(page.getByTestId("entity-history")).toContainText("Committee papers are needed before the meeting");
  await expect(page.locator("dl").filter({ has: page.getByText("Evidence needed by", { exact: true }) }).first()).toContainText("2028-06-10");

  await page.goto("/?place=plan&setting=1L");
  await page.getByRole("button", { name: /^1L comparative evidence: High, priority not confirmed/ }).click();
  await page.getByRole("button", { name: "Review changed context and reconfirm", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Reason for change/).fill("Reviewed papers deadline; High remains appropriate");
  await dialog.getByRole("button", { name: "Confirm priority", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await planState(request)).placements.find(p => p.gap_id === visibleGap)).toMatchObject({ validated: true, needs_review: false, band: "high" });
  await planAction(request, { action: "add_proposal", gap_id: visibleGap, name: "Reconfirmed idea", type: "rwe_study", evidence_question: "New comparative evidence?", rationale: "Reviewed context permits this idea" });

  // Valid unusual/past deadlines remain saveable with a reason; cancelled edits leave history alone.
  await page.goto("/setup");
  await page.getByRole("button", { name: /Objectives & decisions$/ }).click();
  await page.getByLabel("Decision date", { exact: true }).fill("2020-06-30");
  await page.getByLabel(/^Evidence needed by/).fill("2020-07-01");
  await expect(page.getByText("Evidence deadline passed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Evidence deadline follows the decision date/)).toBeVisible();
  await page.getByLabel("Reason for objective changes").fill("Retrospective decision context is intentional");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("setup-step-landscape")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("setup-summary-objectives")).toContainText("Evidence needed by: 2020-07-01");
  await expect(page.getByTestId("setup-summary-objectives")).toContainText("Decision date: 2020-06-30");
  await page.getByRole("button", { name: /Objectives & decisions$/ }).click();
  await page.getByLabel(/^Evidence needed by/).fill("2030-01-01");
  await page.getByRole("button", { name: "Cancel changes", exact: true }).click();
  await expect(page.getByLabel(/^Evidence needed by/)).toHaveValue("2020-07-01");
  await expect(impact).toHaveCount(0);
});
