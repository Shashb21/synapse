/** Visible relationship distinctions and a read-only keyboard library preview. */
import { expect, test } from "@playwright/test";
import { controlAction, iegpAction, planAction, resetWorkspace } from "../support/synapse";
import { freshWorkspace } from "../support/session";

freshWorkspace({ name: "Relationship fit" });

test("KAN-142 explains saved fit, provisional Full and independent confirmation with AI off", async ({ page, request }, testInfo) => {
  await resetWorkspace(request);
  const gap = await iegpAction(request, { action: "create_gap", domain: "comparative_effectiveness", statement: "Comparative adult payer evidence", rationale: "Fit browser fixture" });
  const tactic = await iegpAction(request, { action: "record_missed_tactic", name: "Shared fit study", type: "rwe_study", evidence_question: "Adult outcomes", population: "Adults", comparator: "Placebo", status: "ongoing", rationale: "Fit browser fixture" });
  await iegpAction(request, { action: "assign_tactic", gap_id: gap.id, tactic_id: tactic.id, overall: "partial", dimensions: JSON.stringify({ population: "yes", comparator: "no", outcomes: "unknown", timing: "partial" }), rationale: "Comparator differs; outcomes unknown; timing incomplete" });
  const provisional = await iegpAction(request, { action: "record_missed_tactic", name: "Unconfirmed Full design", type: "rwe_study", evidence_question: "Planned complete design", status: "planned", rationale: "Fit browser fixture" });
  await iegpAction(request, { action: "assign_tactic", gap_id: gap.id, tactic_id: provisional.id, overall: "full", confirm_coverage: "false", rationale: "Design intent awaiting human review" });
  await controlAction(request, { action: "set_ai_enabled", enabled: false, rationale: "Verify fit explanations without AI" });
  try {
    await page.goto(`/gaps/${gap.id}`);
    const details = page.getByTestId("relationship-fit").filter({ has: page.locator("summary", { hasText: "Shared fit study" }) });
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    const fit = details.getByRole("region", { name: "Relationship fit for Shared fit study" });
    await expect(fit).toBeVisible();
    for (const text of ["Documented match (recorded Yes)", "Known mismatch (recorded No)", "Unknown information", "Partial answer (recorded Partial)", "Assessment origin", "Saved judgement", "Human confirmation", "Freshness", "Expected contribution · Design intent", "Delivery of evidence has not been verified by this view."])
      await expect(fit.getByText(text, { exact: false }).first()).toBeVisible();
    await expect(fit.locator("dd").filter({ hasText: /^Human$/ })).toBeVisible();
    await expect(fit.locator("dd").filter({ hasText: /^Confirmed by/ })).toBeVisible();
    await expect(fit.getByText("Dimension: Not confirmed", { exact: true })).toHaveCount(10);
    const full = page.getByTestId("relationship-fit").filter({ has: page.locator("summary", { hasText: "Unconfirmed Full design" }) });
    await full.locator("summary").focus();
    await page.keyboard.press("Space");
    await expect(full.getByText("Full coverage · Provisional", { exact: false })).toBeVisible();
    await expect(full.getByText("The saved overall judgement has not been confirmed by a human.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("kan142-fit-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("kan142-fit-mobile.png"), fullPage: true });
  } finally {
    await controlAction(request, { action: "set_ai_enabled", enabled: true, rationale: "Restore browser test AI switch" });
  }
});

test("KAN-142 previews a selected shared tactic without linking or changing the gap", async ({ page, request }) => {
  await resetWorkspace(request);
  const gap = await iegpAction(request, { action: "create_gap", name: "Preview question", domain: "comparative_effectiveness", statement: "Question awaiting tactic choice", rationale: "Fit browser fixture" });
  await iegpAction(request, { action: "lock_gap", gap_id: gap.id, status: "validated_open", note: "Keep question open for tactic selection" });
  await iegpAction(request, { action: "validate_gap", gap_id: gap.id, note: "Confirm preview question" });
  await planAction(request, { action: "validate_band", gap_id: gap.id, band: "high", rationale: "Prioritize the preview question" });
  await iegpAction(request, { action: "record_missed_tactic", name: "A library study", type: "rwe_study", evidence_question: "First documented question", status: "ongoing", rationale: "Fit browser fixture" });
  const second = await iegpAction(request, { action: "record_missed_tactic", name: "B library study", type: "rwe_study", evidence_question: "Second documented question", status: "planned", rationale: "Fit browser fixture" });
  const before = await (await request.get(`/api/gaps/${gap.id}`)).json();
  await page.goto("/tactics");
  const card = page.getByTestId("ideation-gap").filter({ hasText: "Preview question" });
  const toggle = card.getByTestId("ideation-gap-toggle");
  // The streamed page can display a button before its client handler is attached.
  await expect(async () => {
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 10_000 });
  await card.getByRole("button", { name: "Assign from library", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("From tactic library").selectOption(second.id as string);
  await dialog.locator("summary", { hasText: "Fit to this gap" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("region", { name: "Relationship fit for B library study" })).toBeVisible();
  await expect(dialog.getByText("Second documented question", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("This relationship has not been assessed.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const after = await (await request.get(`/api/gaps/${gap.id}`)).json();
  expect(after).toEqual(before);
  expect(after.coverages).toHaveLength(0);
  expect(after.residuals).toHaveLength(before.residuals.length);
});


test("KAN-143 deliberately links unassessed and retains a rejected assessment for keyboard correction", async ({ page, request }) => {
  await resetWorkspace(request);
  const gap = await iegpAction(request, { action: "create_gap", name: "Library linking question", domain: "comparative_effectiveness", statement: "Unresolved requirements for the library linking decision", rationale: "Link browser fixture" });
  await iegpAction(request, { action: "lock_gap", gap_id: gap.id, status: "validated_open", note: "Keep question open for library linking" });
  await iegpAction(request, { action: "validate_gap", gap_id: gap.id, note: "Confirm linking question" });
  await planAction(request, { action: "validate_band", gap_id: gap.id, band: "high", rationale: "Prioritize linking question" });
  const unassessed = await iegpAction(request, { action: "record_missed_tactic", name: "A unassessed library study", type: "rwe_study", evidence_question: "Unassessed study question", status: "ongoing", rationale: "Link browser fixture" });
  const assessed = await iegpAction(request, { action: "record_missed_tactic", name: "B assessed library study", type: "rwe_study", evidence_question: "Partially answered study question", comparator: "Placebo", status: "planned", rationale: "Link browser fixture" });
  await page.goto("/tactics");
  const card = page.getByTestId("ideation-gap").filter({ hasText: "Library linking question" });
  const toggle = card.getByTestId("ideation-gap-toggle");
  await expect(async () => {
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 10_000 });
  const trigger = card.getByRole("button", { name: "Assign from library", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("From tactic library")).toBeFocused();
  await dialog.getByLabel("From tactic library").selectOption(unassessed.id as string);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect((await (await request.get(`/api/gaps/${gap.id}`)).json()).coverages).toHaveLength(0);
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rationale (required)", { exact: true }).fill("Link this study for a later coverage assessment");
  await dialog.getByRole("button", { name: "Link as unassessed", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  let record = await (await request.get(`/api/gaps/${gap.id}`)).json();
  expect(record.coverages).toHaveLength(1);
  expect(record.coverages[0].fit.overall).toBe("unassessed");
  expect(record.coverages[0].fit.confirmation.locked).toBe(false);
  await trigger.click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("From tactic library").selectOption(assessed.id as string);
  await dialog.getByRole("button", { name: "Assess and link", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Overall coverage", { exact: true })).toBeFocused();
  await dialog.getByLabel("Overall coverage", { exact: true }).selectOption("full");
  await dialog.getByLabel("Comparator", { exact: true }).selectOption("no");
  await dialog.getByLabel("Rationale (required)", { exact: true }).fill("The comparator differs; retain this explanation after rejection");
  await dialog.getByRole("button", { name: "Assess and link", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("alert")).toBeFocused();
  await expect(dialog.getByLabel("From tactic library")).toHaveValue(assessed.id as string);
  await expect(dialog.getByLabel("Overall coverage", { exact: true })).toHaveValue("full");
  await expect(dialog.getByLabel("Comparator", { exact: true })).toHaveValue("no");
  await expect(dialog.getByLabel("Rationale (required)", { exact: true })).toHaveValue("The comparator differs; retain this explanation after rejection");
  record = await (await request.get(`/api/gaps/${gap.id}`)).json();
  expect(record.coverages).toHaveLength(1);
  expect(record.coverages.some((coverage: { tactic_id: string }) => coverage.tactic_id === assessed.id)).toBe(false);
  await dialog.getByLabel("Overall coverage", { exact: true }).selectOption("partial");
  await dialog.getByRole("button", { name: "Assess and link", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  record = await (await request.get(`/api/gaps/${gap.id}`)).json();
  expect(record.coverages).toHaveLength(2);
  const saved = record.coverages.find((coverage: { tactic_id: string }) => coverage.tactic_id === assessed.id);
  expect(saved.fit).toMatchObject({ overall: "partial", assessment_origin: "human", confirmation: { locked: true } });
  expect(saved.fit.dimensions.find((dimension: { dimension: string }) => dimension.dimension === "comparator")).toMatchObject({ verdict: "no", confirmation: { locked: false } });
});
