import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction, planAction, planActionExpectingError, planState } from "../support/synapse";

test.use({ actionTimeout: 10_000 });

let visibleGap = "", hiddenGap = "", tacticId = "";
freshWorkspace({ name: "KAN131 direct gap edits", seed: async request => {
  await iegpAction(request, { action: "save_product_setup", mark_complete: true, reason: "Record the initial committee context", context: {
    asset_name: "Deadline study", therapeutic_area: "Immunology", indications: [{ name: "Psoriasis", status: "current" }],
    lifecycle_stage: "growth", markets: ["US"], plan_owner: "Evidence lead", sponsoring_function: "Medical Affairs",
    stakeholders: [{ function: "HEOR", lead: "Evidence lead" }], treatment_settings: ["1L", "2L"],
    objectives: [{ name: "Committee submission", key_decision: "Committee meeting", decision_date: "2028-06-30" }, { name: "Safety committee", key_decision: "Safety monitoring decision", decision_date: "2028-09-01" }],
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

test("audits direct gap edits, retains failed input and previous judgement, and requires reconfirmation for meaning changes", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(`/gaps/${visibleGap}`);
  await page.getByRole("button", { name: /^Edit GAP-/ }).click();
  const dialog = page.getByRole("dialog").filter({ hasNot: page.getByRole("heading", { name: "Gap details", exact: true }) });
  await expect(dialog).toContainText("Changing Evidence needed requires priority review again");
  await dialog.getByLabel("Name (required)", { exact: true }).fill("Clearer comparative evidence name");
  await dialog.getByLabel("Rationale (required)").fill("Clarify the display name only");
  await dialog.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Clearer comparative evidence name", exact: true })).toBeVisible();
  expect((await planState(request)).placements.find(row => row.gap_id === visibleGap)).toMatchObject({ validated: true, needs_review: false });

  const details = page.getByTestId("gap-metadata");
  await details.getByRole("textbox", { name: "Notes", exact: true }).fill("Follow up with the committee");
  await details.getByRole("button", { name: "Save details" }).click();
  await expect(details.getByRole("alert")).toContainText("meaningful reason");
  await details.getByLabel("Reason for details change (required)").fill("Record the committee follow-up");
  await page.route("**/api/plan", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Save failed; retry details" }) }), { times: 1 });
  await details.getByRole("button", { name: "Save details" }).click();
  await expect(details.getByRole("alert")).toContainText("Save failed");
  await expect(details.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("Follow up with the committee");
  await expect(details.getByLabel("Reason for details change (required)")).toHaveValue("Record the committee follow-up");
  await details.getByRole("button", { name: "Save details" }).click();
  await expect(details.getByRole("status")).toHaveText("Details saved.");
  expect((await planState(request)).placements.find(row => row.gap_id === visibleGap)!.validated).toBe(true);

  await page.getByLabel("Add a treatment setting").fill("3L");
  await page.getByLabel("Add a treatment setting").press("Enter");
  await page.getByLabel("Reason for settings change (required)").fill("Also relevant in the third-line setting");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toHaveCount(0);
  expect((await planState(request)).placements.find(row => row.gap_id === visibleGap)!.validated).toBe(true);

  // Cancelling leaves the saved evidence statement and confirmation unchanged.
  await page.getByRole("button", { name: /^Edit GAP-/ }).click();
  await dialog.getByRole("textbox", { name: "Evidence needed (required)", exact: true }).fill("Discarded statement draft");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("Discarded statement draft", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Edit GAP-/ }).click();
  await dialog.getByRole("textbox", { name: "Evidence needed (required)", exact: true }).fill("Missing long-term comparative survival evidence");
  await dialog.getByLabel("Rationale (required)").fill("The committee needs longer follow-up evidence");
  await page.route("**/api/iegp", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Save failed; retry evidence edit" }) }), { times: 1 });
  await dialog.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Save failed");
  await expect(dialog.getByRole("textbox", { name: "Evidence needed (required)", exact: true })).toHaveValue("Missing long-term comparative survival evidence");
  await expect(dialog.getByLabel("Rationale (required)")).toHaveValue("The committee needs longer follow-up evidence");
  await dialog.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId("gap-priority")).toContainText("Review changed context and revalidate priority");
  await expect(page.getByTestId("gap-priority")).toContainText("Evidence blocks the committee decision");
  if (await page.getByRole("group", { name: "History", exact: true }).getAttribute("open") === null) await page.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(page.getByTestId("entity-history")).toContainText("The committee needs longer follow-up evidence");
  await expect(page.getByText("Missing long-term comparative survival evidence", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("gap-ideas")).toContainText("Existing committee study");
  expect((await planState(request)).placements.find(row => row.gap_id === hiddenGap)!.validated).toBe(true);
  expect((await planActionExpectingError(request, { action: "add_proposal", gap_id: visibleGap, name: "Premature new idea", type: "rwe_study", evidence_question: "New evidence?", rationale: "Before reconfirmation" })).status).toBe(400);
  await page.goto(`/tactics/${tacticId}`);
  await expect(page.getByText("Existing committee study", { exact: true }).first()).toBeVisible();
  await page.goto("/?place=plan&setting=1L");
  await page.getByRole("button", { name: /^Clearer comparative evidence name: High, priority not validated/ }).click();
  await page.getByRole("button", { name: "Review changed context and revalidate priority", exact: true }).click();
  await dialog.getByLabel(/^Reason for change/).fill("Reviewed the revised statement; High remains appropriate");
  await dialog.getByRole("button", { name: "Validate priority", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await planState(request)).placements.find(row => row.gap_id === visibleGap)).toMatchObject({ validated: true, needs_review: false, rationale: "Evidence blocks the committee decision" });
  await planAction(request, { action: "add_proposal", gap_id: visibleGap, name: "Reconfirmed evidence idea", type: "rwe_study", evidence_question: "New comparative evidence?", rationale: "Reconfirmed context permits ideation" });

  await page.goto(`/gaps/${visibleGap}`);
  await page.getByRole("button", { name: "Change objective", exact: true }).click();
  await expect(dialog).toContainText("Open gaps need priority review again");
  await dialog.getByRole("combobox", { name: "Objective (required)", exact: true }).selectOption({ index: 1 });
  await dialog.getByLabel("Reason for objective change (required)").fill("Evidence now serves safety monitoring");
  await dialog.getByRole("button", { name: "Save objective", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId("gap-objective")).toContainText("Safety committee");
  await expect(page.getByTestId("gap-priority")).toContainText("Review changed context and revalidate priority");
  if (await page.getByRole("group", { name: "History", exact: true }).getAttribute("open") === null) await page.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(page.getByTestId("entity-history")).toContainText("Evidence now serves safety monitoring");
  await expect(page.getByTestId("gap-ideas")).toContainText("Existing committee study");
  expect((await planState(request)).placements.find(row => row.gap_id === visibleGap)).toMatchObject({ band: "high", validated: false, needs_review: true, axis_scores: { decision_impact: 80, time_pressure: 75 }, rationale: "Evidence blocks the committee decision" });
  await page.goto("/?place=plan&setting=1L");
  await page.getByRole("button", { name: /^Clearer comparative evidence name: High, priority not validated/ }).click();
  await page.getByRole("button", { name: "Review changed context and revalidate priority", exact: true }).click();
  await dialog.getByLabel(/^Reason for change/).fill("Reviewed the safety objective; High remains appropriate");
  await dialog.getByRole("button", { name: "Validate priority", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await planState(request)).placements.find(row => row.gap_id === visibleGap)).toMatchObject({ validated: true, needs_review: false });
});
