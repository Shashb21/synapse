import { expect, test, type APIRequestContext } from "@playwright/test";
import { iegpAction, planAction } from "../support/synapse";

/**
 * Place by hand on the Prioritize matrix, with AI off so nothing is placed for
 * you. A score out of range is refused with the axis name (not an internal
 * field name), and a corrected save moves the gap onto the matrix at once.
 */
async function setAi(request: APIRequestContext, enabled: boolean) {
  const res = await request.post("/api/control", {
    data: { action: "set_ai_enabled", enabled, rationale: enabled ? "e2e: AI back on" : "e2e: manual mode" },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe.configure({ mode: "serial" });

test.describe("Place by hand", () => {
  let gapIds: string[] = [];
  test.beforeAll(async ({ request }) => {
    // A blank plan with two hand-made, confirmed Open gaps and no placement rows yet.
    await setAi(request, false);
    await iegpAction(request, { action: "reset" });
    // Gap ids are never reissued after a reset (KAN-15), so use the ids the server hands back.
    gapIds = [];
    for (const [name, statement] of [
      ["Hand gap one", "No comparative persistence data versus the standard of care in routine practice."],
      ["Hand gap two", "No caregiver burden evidence for the HTA submission in the EU5."],
    ]) {
      const created = await iegpAction(request, { action: "create_gap", name, statement, domain: "unmet_need" });
      gapIds.push(String(created.id));
    }
    for (const gap_id of gapIds) {
      await iegpAction(request, { action: "validate_gap", gap_id });
    }
    await planAction(request, { action: "save_scope_axes", scope: "all", x_axis: "feasibility", y_axis: "payer_value" });
  });

  test.afterAll(async ({ request }) => {
    await setAi(request, true);
  });

  test("an out-of-range score names the axis, and the fixed save places the gap", async ({ page }) => {
    await page.goto("/?place=plan&setting=all");
    const unplaced = page.getByRole("region", { name: "Gaps not placed yet" });
    await expect(unplaced).toBeVisible();
    const before = await unplaced.getByRole("listitem").count();
    expect(before).toBeGreaterThan(0);
    const first = unplaced.getByRole("listitem").first();
    const gapName = (await first.locator(".truncate").first().innerText()).trim();

    const trigger = page.getByRole("button", { name: "Set priority", exact: true });
    const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
    const dialog = page.getByRole("dialog").filter({ hasNot: page.getByRole("heading", { name: "Gap details", exact: true }) });
    await expect(async () => {
      if (!(await panel.isVisible())) await first.getByRole("button").click();
      await trigger.click({ timeout: 1_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    const yInput = dialog.locator('input[name="y_score"]');
    const xInput = dialog.locator('input[name="x_score"]');
    // The Y axis is Payer / HTA relevance (set in beforeAll).
    const axisLabel = "Payer / HTA relevance";
    await expect(dialog.getByText(`${axisLabel} score (0–100)`)).toBeVisible();

    await yInput.fill("150");
    await xInput.fill("60");
    await dialog.getByPlaceholder("Why this decision, in one line").fill("Placed by hand in the e2e");
    await dialog.getByRole("button", { name: "Save placement" }).click();
    const error = dialog.getByText(`${axisLabel} score must be a number from 0 to 100.`);
    await expect(error).toBeVisible();
    await expect(panel.getByRole("status").filter({ hasText: "Draft placement saved" })).toHaveCount(0);
    await expect(dialog.getByText(/y_score|x_score/)).toHaveCount(0);

    // The server refuses it the same way, naming the axis.
    const invalidOpening = await (await page.request.get("/api/plan")).json();
    const res = await page.request.post("/api/plan", {
      data: {
        action: "set_placement",
        gap_id: gapIds[0],
        x_axis: "feasibility",
        y_axis: "payer_value",
        y_score: 150,
        x_score: 60,
        rationale: "Assess the manual axis scores",
        reason: "Assess the manual axis scores",
        expected_version: invalidOpening.placements.find((row: { gap_id: string }) => row.gap_id === gapIds[0])?.version ?? null,
        expected_context_version: invalidOpening.priority_context_versions[gapIds[0]!],
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe(`${axisLabel} score must be a number from 0 to 100.`);

    await yInput.fill("80");
    await dialog.getByRole("button", { name: "Save placement" }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole("status").filter({ hasText: "Draft placement saved." })).toContainText("Draft placement saved. Validate priority when you are ready.");

    await page.keyboard.press("Escape");
    // No reload: the gap leaves Not placed yet and shows on the matrix.
    await expect(async () => {
      const after = (await unplaced.isVisible()) ? await unplaced.getByRole("listitem").count() : 0;
      expect(after).toBe(before - 1);
    }).toPass({ timeout: 15_000 });
    await expect(unplaced.getByText(gapName, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /(High|Medium|Low) gaps/ }).getByText(gapName).first()).toBeVisible();
  });

  test("a save the server refuses, then a corrected one, refreshes the matrix at once", async ({ page }) => {
    await page.goto("/?place=plan&setting=all");
    const unplaced = page.getByRole("region", { name: "Gaps not placed yet" });
    await expect(unplaced.getByRole("listitem")).toHaveCount(1);
    const row = unplaced.getByRole("listitem").first();
    const gapName = (await row.locator(".truncate").first().innerText()).trim();
    const trigger = page.getByRole("button", { name: "Set priority", exact: true });
    const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
    const dialog = page.getByRole("dialog").filter({ hasNot: page.getByRole("heading", { name: "Gap details", exact: true }) });
    const open = async () =>
      expect(async () => {
        if (!(await panel.isVisible())) await row.getByRole("button").click();
        await trigger.click({ timeout: 1_000 });
        await expect(dialog).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
    await open();
    const save = dialog.getByRole("button", { name: "Save placement" });
    const rationale = dialog.getByPlaceholder("Why this decision, in one line");

    // One score and no band would leave the gap off the matrix: refused, with why.
    await dialog.locator('input[name="y_score"]').fill("70");
    await rationale.fill("Placed by hand in the e2e");
    await save.click();
    await expect(
      dialog.getByText("Give the Feasibility score too, so the gap has a place on the matrix, or pick a band."),
    ).toBeVisible();

    // The first save fails on the server; the dialog stays open with the error.
    let refused = 0;
    await page.route("**/api/plan", async (route) => {
      if (route.request().method() === "POST" && refused === 0) {
        refused += 1;
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ safe_error: true, request_outcome: "rejected", error: "The placement was refused. Review the scores and try again." }) });
        return;
      }
      await route.fallback();
    });
    await dialog.locator('input[name="x_score"]').fill("30");
    await save.click();
    await expect(dialog.getByText("The placement was refused. Review the scores and try again.", { exact: true })).toBeVisible();
    await expect(dialog.locator('input[name="x_score"]')).toHaveValue("30");
    await expect(rationale).toHaveValue("Placed by hand in the e2e");

    // Reopening starts clean after explicitly discarding the unsaved draft.
    page.once("dialog", confirmation => confirmation.accept());
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await open();
    await expect(dialog.getByText("The placement was refused. Review the scores and try again.", { exact: true })).toHaveCount(0);

    // The corrected save succeeds and the gap leaves Not placed yet without a reload.
    await dialog.locator('input[name="y_score"]').fill("70");
    await dialog.locator('input[name="x_score"]').fill("30");
    await rationale.fill("Placed by hand in the e2e");
    await save.click();
    await expect(dialog).toBeHidden();
    await page.keyboard.press("Escape");
    expect(refused).toBe(1);
    await expect(unplaced).toHaveCount(0);
    await expect(page.getByRole("region", { name: /(High|Medium|Low) gaps/ }).getByText(gapName).first()).toBeVisible();
  });

  // Owner feedback (KAN-52): drag a gap from the list onto the matrix; where it lands sets its scores.
  test("a gap dragged from the list onto the matrix is placed where it is dropped", async ({ page, request }) => {
    test.setTimeout(90_000);
    const created = await iegpAction(request, {
      action: "create_gap",
      name: "Drag gap three",
      statement: "No real-world outcomes in patients over 75 for the German dossier.",
      domain: "unmet_need",
    });
    await iegpAction(request, { action: "validate_gap", gap_id: String(created.id) });
    await page.goto("/?place=plan&setting=all");
    const unplaced = page.getByRole("region", { name: "Gaps not placed yet" });
    const item = unplaced.getByTestId("unplaced-gap").filter({ hasText: "Drag gap three" });
    await expect(item).toBeVisible();
    await page.waitForLoadState("networkidle");
    const plot = page.getByRole("group", { name: /^Prioritization matrix:/ });
    // The controls sit above the matrix (KAN-56), so the list can start below the fold.
    await item.scrollIntoViewIfNeeded();
    const box = (await plot.boundingBox())!;
    const from = (await item.boundingBox())!;

    // A drop outside the matrix places nothing.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + 120, { steps: 6 });
    await page.mouse.up();
    await expect(item).toBeVisible();

    // Drop in the top-right quadrant: favourable on both axes, so Prioritize (High).
    const to = { x: box.x + box.width * 0.8, y: box.y + box.height * 0.2 };
    const again = (await item.boundingBox())!;
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();

    const decision = page.getByRole("dialog", { name: "Review matrix move for Drag gap three", exact: true });
    await expect(decision).toBeVisible();
    await decision.getByLabel("Reason for change (required)").fill("Cancelled preview must not be recorded");
    page.once("dialog", confirmation => confirmation.accept());
    await page.keyboard.press("Escape");
    await expect(item).toBeVisible();
    await expect(item).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Matrix placement saved" })).toHaveCount(0);
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
    const cancelled = await (await request.get("/api/plan")).json();
    expect(cancelled.placements.find((row: { gap_id: string }) => row.gap_id === String(created.id))).toBeUndefined();
    const retry = (await item.boundingBox())!;
    const retryPlot = (await plot.boundingBox())!;
    await page.mouse.move(retry.x + retry.width / 2, retry.y + retry.height / 2);
    await page.mouse.down();
    await page.mouse.move(retryPlot.x + retryPlot.width * 0.8, retryPlot.y + retryPlot.height * 0.2, { steps: 12 });
    await page.mouse.up();
    await expect(decision).toBeVisible();
    await decision.getByRole("button", { name: "Save matrix move" }).click();
    await expect(decision.getByRole("alert")).toContainText("reason is required");
    await decision.getByLabel("Reason for change (required)").fill("Dragged after reviewing payer impact");
    const saveResponse = page.waitForResponse(response => response.url().endsWith("/api/plan") && response.request().method() === "POST");
    await decision.getByRole("button", { name: "Save matrix move" }).click();
    const saved = await saveResponse;
    expect(saved.ok(), await saved.text()).toBe(true);
    await expect(decision).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole("status")).toContainText("Matrix placement saved as a draft.");
    await expect(item).toHaveCount(0);
    const chip = plot.getByRole("button", { name: /^Drag gap three: High/ });
    await expect(chip).toBeVisible();
    // It stays there after a reload: the scores were saved.
    await page.reload();
    await expect(page.getByRole("group", { name: /^Prioritization matrix:/ }).getByRole("button", { name: /^Drag gap three: High/ })).toBeVisible();
  });

  test("manual change, stale retry, keyboard move and reconfirmation retain attributable history after refresh", async ({ page }) => {
    test.setTimeout(120_000);
    const gapId = gapIds[0]!;
    await page.goto("/?place=plan&setting=all");
    const plot = page.getByRole("group", { name: /^Prioritization matrix:/ });
    await plot.getByRole("button", { name: /^Hand gap one:/ }).click();
    await page.getByRole("button", { name: "Edit scores", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ hasNot: page.getByRole("heading", { name: "Gap details", exact: true }) });
    await dialog.locator('input[name="x_score"]').fill("90");
    await dialog.locator('textarea[name="rationale"]').fill("Needed before the payer decision");
    const reason = dialog.getByLabel("Reason for change (required)");
    await reason.fill("Updated following manual assessment");
    const state = await (await page.request.get("/api/plan")).json();
    const current = state.placements.find((row: { gap_id: string }) => row.gap_id === gapId);
    const competingBand = current.band === "medium" ? "low" : "medium";
    const competing = await page.request.post("/api/plan", { data: { action: "set_placement", gap_id: gapId, band: competingBand, reason: "Colleague changed the band", expected_version: current.version, expected_context_version: state.priority_context_versions[gapId] } });
    expect(competing.ok(), await competing.text()).toBe(true);
    const changed = await (await page.request.get("/api/plan")).json();
    const changedPlacement = changed.placements.find((row: { gap_id: string }) => row.gap_id === gapId);
    expect(changedPlacement.band).toBe(competingBand);
    expect(changedPlacement.version).not.toBe(current.version);
    await dialog.getByRole("button", { name: "Save placement" }).click();
    await expect(dialog.getByRole("alert")).toContainText("review the latest priority");
    await expect(page.getByRole("status").filter({ hasText: /Draft placement saved|Priority validated/ })).toHaveCount(0);
    await expect(dialog.locator('input[name="x_score"]')).toHaveValue("90");
    await expect(reason).toHaveValue("Updated following manual assessment");
    page.once("dialog", confirmation => confirmation.accept());
    await page.keyboard.press("Escape");
    await page.reload();
    await plot.getByRole("button", { name: /^Hand gap one:/ }).click();
    await page.getByRole("button", { name: "Edit scores", exact: true }).click();
    await dialog.locator('input[name="x_score"]').fill("90");
    await dialog.locator('textarea[name="rationale"]').fill("Needed before the payer decision");
    await reason.fill("Updated following manual assessment");
    await dialog.getByRole("button", { name: "Save placement" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Draft placement saved" })).toBeVisible();
    await page.getByRole("button", { name: "Validate priority", exact: true }).click();
    await reason.fill("Confirmed after reviewing the manual change");
    await dialog.getByRole("button", { name: "Validate priority", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Priority validated across all settings." })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Gap details", exact: true })).not.toBeVisible();
    const chip = plot.getByRole("button", { name: /^Hand gap one:/ });
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toBeVisible();
    await reason.fill("Fine-tuned the score with the keyboard");
    await dialog.getByRole("button", { name: "Save matrix move" }).click();
    await expect(dialog).toBeHidden();
    await expect(chip).toBeFocused();
    await chip.click();
    await page.getByRole("button", { name: "Review or change validated priority", exact: true }).click();
    await reason.fill("Team deliberately reconfirmed the same band");
    await dialog.getByRole("button", { name: "Validate priority", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.goto(`/gaps/${gapId}`);
    await page.reload();
    await page.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
    const history = page.getByTestId("entity-history");
    await expect(history).toContainText("Updated following manual assessment");
    await expect(history).toContainText("Confirmed after reviewing the manual change");
    await expect(history).toContainText("Fine-tuned the score with the keyboard");
    await expect(history).toContainText("Team deliberately reconfirmed the same band");
    const latest = history.getByTestId("history-entry").first();
    await expect(latest).toContainText("Feature E2E");
    await latest.getByText("Show full change", { exact: true }).click();
    await expect(latest.locator("details")).toContainText("Priority confirmed");
    await expect(latest.locator("details")).toContainText("Needed before the payer decision");
    await expect(page.getByTestId("gap-priority")).toContainText("Needed before the payer decision");
  });

});
