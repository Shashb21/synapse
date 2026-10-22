import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction, planAction } from "../support/synapse";

let gapId = "";
freshWorkspace({ name: "KAN133 shared gap panel", seed: async request => {
  await iegpAction(request, { action: "save_product_setup", mark_complete: true, reason: "Initial evidence planning context", context: {
    asset_name: "Panel study", therapeutic_area: "Immunology", indications: [{ name: "Psoriasis", status: "current" }], lifecycle_stage: "growth", markets: ["US"], plan_owner: "Evidence lead", sponsoring_function: "Medical Affairs", stakeholders: [{ function: "HEOR", lead: "Evidence lead" }], treatment_settings: ["1L", "2L"], objectives: [{ name: "Committee submission", key_decision: "Committee meeting", decision_date: "2028-06-30" }],
  } });
  const created = await iegpAction(request, { action: "create_gap", name: "Comparative panel evidence", statement: "Comparative survival evidence is missing.", domain: "comparative_effectiveness", settings: "1L" });
  gapId = String(created.id);
  await iegpAction(request, { action: "validate_gap", gap_id: gapId });
  await planAction(request, { action: "set_placement", gap_id: gapId, band: "high", validate: true, axis_scores: { decision_impact: 80, time_pressure: 75 }, rationale: "Evidence blocks the committee decision", reason: "Initial priority review" });
  await iegpAction(request, { action: "complete_wizard", note: "Inventory reviewed" });
  await iegpAction(request, { action: "unlock_tactics", note: "Initial priorities confirmed" });
} });

test("Inventory opens a keyboard accessible gap panel with collapsed history and full-record fallback", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/?place=gaps");
  await page.getByPlaceholder("Search gaps…").fill("Comparative panel");
  const trigger = page.getByTestId("gap-row-toggle").filter({ hasText: "Comparative panel evidence" });
  await trigger.focus();
  const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("definition").filter({ hasText: "Comparative survival evidence is missing." })).toBeVisible();
  await expect(panel.getByTestId("gap-priority")).toContainText("Evidence blocks the committee decision");
  const history = panel.getByRole("group", { name: "History", exact: true });
  await expect(history).not.toHaveAttribute("open");
  await history.locator("summary").first().click();
  await expect(panel.getByTestId("entity-history")).toContainText("Initial priority review");
  await panel.screenshot({ path: testInfo.outputPath("gap-panel-history.png") });
  await expect(panel.getByRole("link", { name: "Open full record", exact: true })).toHaveAttribute("href", `/gaps/${gapId}`);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(position);
  await expect(page.getByPlaceholder("Search gaps…")).toHaveValue("Comparative panel");
  await trigger.click();
  await panel.getByRole("link", { name: "Open full record", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/gaps/${gapId}$`));
  const fullHistory = page.getByRole("group", { name: "History", exact: true });
  await expect(fullHistory).not.toHaveAttribute("open");
  await expect(fullHistory.getByTestId("entity-history")).toBeHidden();
  await fullHistory.locator("summary").first().focus();
  await page.keyboard.press("Enter");
  await expect(fullHistory.getByTestId("entity-history")).toContainText("Initial priority review");
  await expect(page.getByTestId("gap-priority")).toContainText("Evidence blocks the committee decision");
});


test("load failure retains the gap and Inventory filters for retry, with full-screen narrow layout", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?place=gaps");
  await page.getByPlaceholder("Search gaps…").fill("Comparative panel");
  let failing = true;
  let release!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/gaps/${gapId}`, async route => {
    await loading;
    if (failing) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
    else await route.continue();
  });
  const trigger = page.getByTestId("gap-row-toggle");
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
  await expect(panel.getByRole("status")).toHaveText("Loading gap details…");
  release();
  await expect(panel.getByRole("alert")).toContainText("could not be loaded");
  const bounds = await panel.boundingBox();
  expect(bounds!.width).toBeCloseTo(390, 2);
  expect(bounds!.height).toBeCloseTo(844, 2);
  failing = false;
  await panel.getByRole("button", { name: "Retry gap details" }).click();
  await expect(panel.getByTestId("gap-priority")).toContainText("Priority validated");
  await panel.screenshot({ path: testInfo.outputPath("gap-panel-narrow.png") });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByPlaceholder("Search gaps…")).toHaveValue("Comparative panel");
});

test("Prioritisation opens shared details, contains focus, and retains dirty priority edits on Escape", async ({ page }) => {
  await page.goto("/?place=plan&setting=1L");
  const trigger = page.getByRole("button", { name: /^Comparative panel evidence: High/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
  await expect(panel.getByTestId("gap-priority")).toContainText("Evidence blocks the committee decision");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await panel.getByRole("button", { name: "Edit scores", exact: true }).click();
  const editor = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Save placement", exact: true }) });
  await editor.getByLabel("Priority rationale (optional)").fill("Unsaved priority explanation");
  page.once("dialog", dialog => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(editor.getByLabel("Priority rationale (optional)")).toHaveValue("Unsaved priority explanation");
  page.once("dialog", dialog => dialog.accept());
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/setting=1L/);
});

test("Tactics gap and library relationship entry points share the panel and retain board filters", async ({ page, request }) => {
  const added = await planAction(request, { action: "add_proposal", gap_id: gapId, name: "Panel retained study", type: "rwe_study", evidence_question: "What is comparative survival?", rationale: "Retain existing planned evidence work" });
  await planAction(request, { action: "decide_proposal", id: (added.proposal as { id: string }).id, decision: "accept", rationale: "Keep this tactic in the plan" });
  await page.goto("/?place=tactics");
  await page.getByPlaceholder("Search gaps…").fill("Comparative panel");
  await page.getByRole("button", { name: /Comparative panel evidence/ }).click();
  const trigger = page.getByRole("link", { name: "Open gap ↗", exact: true });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
  await expect(panel.getByTestId("gap-ideas")).toContainText("Panel retained study");
  await expect(panel.getByRole("region", { name: "Linked tactics" })).toContainText("Panel retained study");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByPlaceholder("Search gaps…")).toHaveValue("Comparative panel");
  await page.getByRole("button", { name: /Tactic Library/ }).click();
  const relationship = page.getByRole("link", { name: gapId, exact: true }).first();
  await relationship.click();
  await expect(panel.getByTestId("gap-priority")).toContainText("Priority validated");
  await page.keyboard.press("Escape");
  await expect(relationship).toBeFocused();
  await page.goto("/ideation");
  const reviewGap = page.getByRole("link", { name: "Comparative panel evidence", exact: true });
  await reviewGap.click();
  await expect(panel.getByTestId("gap-ideas")).toContainText("Panel retained study");
  await page.keyboard.press("Escape");
  await expect(reviewGap).toBeFocused();
});


test("empty history and unavailable detail states keep the full-record route and selection", async ({ page, request }) => {
  const original = await request.get(`/api/gaps/${gapId}`).then(response => response.json());
  let status = 200;
  await page.route(`**/api/gaps/${gapId}`, route => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { ...original, history: [] } : { error: "Unavailable" }) }));
  await page.goto("/?place=gaps");
  const trigger = page.getByTestId("gap-row-toggle").filter({ hasText: "Comparative panel evidence" });
  const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
  await trigger.click();
  await panel.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(panel.getByTestId("entity-history")).toContainText("No changes recorded yet.");
  await expect(panel.getByTestId("entity-history").getByTestId("history-entry")).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (status of [404, 403]) {
    await trigger.click();
    await expect(panel.getByRole("alert")).toContainText(status === 404 ? "missing or unavailable" : "do not currently have access");
    await expect(panel.getByRole("link", { name: "Open full record", exact: true })).toHaveAttribute("href", `/gaps/${gapId}`);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
});

test("Prioritisation addressed records use shared details after new unresolved Inventory work", async ({ page, request }) => {
  const added = await iegpAction(request, { action: "create_gap", name: "Addressed panel record", statement: "Evidence already available", domain: "comparative_effectiveness" });
  const addressedId = String(added.id);
  await iegpAction(request, { action: "override_gap_status", gap_id: addressedId, status: "validated_addressed", reason: "Existing evidence covers the decision" });
  await iegpAction(request, { action: "validate_gap", gap_id: addressedId });
  await iegpAction(request, { action: "create_gap", name: "New unresolved inventory evidence", statement: "New unresolved evidence need", domain: "unmet_need" });
  await page.goto("/?place=plan");
  await page.locator("summary").filter({ hasText: "Addressed" }).click();
  const trigger = page.getByRole("link", { name: "Addressed panel record", exact: true });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
  await expect(panel.getByRole("definition").filter({ hasText: "Evidence already available" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open full record", exact: true })).toHaveAttribute("href", `/gaps/${addressedId}`);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.goto("/?place=tactics");
  await expect(page.getByRole("button", { name: /Tactic Library/ })).toBeVisible();
  await page.goto("/?place=gaps");
  await page.getByTestId("gap-row-toggle").filter({ hasText: "New unresolved inventory evidence" }).click();
  await panel.getByRole("link", { name: "Edit gap and mappings", exact: true }).click();
  await page.getByRole("button", { name: "Confirm evidence assessment", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: /reason|rationale|note/i }).fill("Reviewed the newly added evidence need against current study coverage");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm evidence assessment", exact: true }).click();
  await expect(page.getByTestId("gap-confirmation")).toContainText("Confirmed by");
});


test("dirty keyboard matrix moves retain the proposed move and reason through Escape and failed saves", async ({ page, request }) => {
  await page.goto("/?place=plan&setting=1L");
  const trigger = page.getByRole("button", { name: /^Comparative panel evidence: High/ });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  const move = page.getByRole("dialog", { name: /Review matrix move for Comparative panel evidence/ });
  const proposed = await move.locator('[data-slot="dialog-description"]').textContent();
  const reason = move.getByLabel("Reason for change (required)");
  await reason.fill("Retain this proposed matrix adjustment");
  let prompts = 0;
  page.on("dialog", async dialog => { prompts++; await dialog.dismiss(); });
  await page.keyboard.press("Escape");
  expect(prompts).toBe(1);
  await expect(reason).toHaveValue("Retain this proposed matrix adjustment");
  await expect(move.locator('[data-slot="dialog-description"]')).toHaveText(proposed!);
  const before = await request.get("/api/plan").then(response => response.json());
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/plan", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().action === "move_placement") {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Matrix save failed; retry" }) });
    }
    await route.continue();
  });
  await move.getByRole("button", { name: "Save matrix move" }).click();
  await expect(move.getByRole("alert")).toContainText("Matrix save failed");
  await page.keyboard.press("Escape");
  expect(prompts).toBe(2);
  await expect(reason).toHaveValue("Retain this proposed matrix adjustment");
  const unchanged = await request.get("/api/plan").then(response => response.json());
  expect(unchanged.placements).toEqual(before.placements);
  await move.getByRole("button", { name: "Save matrix move" }).click();
  await expect(move).not.toBeVisible();
  expect(submissions[1]).toEqual(submissions[0]);
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await reason.fill("Discard only after explicit confirmation");
  page.removeAllListeners("dialog");
  page.once("dialog", dialog => dialog.accept());
  await page.keyboard.press("Escape");
  await expect(move).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("Partial and unconfirmed panels share coverage context and full-record next steps", async ({ page, request }) => {
  const open = await iegpAction(request, { action: "create_gap", name: "Unconfirmed coverage panel", statement: "Unreviewed evidence need", domain: "unmet_need" });
  const partial = await iegpAction(request, { action: "create_gap", name: "Partial coverage panel", statement: "Some comparative evidence is missing", domain: "unmet_need" });
  await iegpAction(request, { action: "record_missed_tactic", gap_id: String(partial.id), name: "Existing partial evidence study", rationale: "Record existing work that addresses the studied population", evidence_question: "What evidence is available in the studied population?", type: "chart_review", status: "planned", description: "Existing study addresses part of the population", catch_up_reason: "remembered_while_reviewing" });
  for (const [id, name, status, next] of [[String(open.id), "Unconfirmed coverage panel", "Open", "Confirm evidence assessment"], [String(partial.id), "Partial coverage panel", "Partially Addressed", "Resolve — split or rewrite"]]) {
    await page.goto("/?place=gaps");
    await page.getByTestId("gap-row-toggle").filter({ hasText: name }).click();
    const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
    const context = panel.getByTestId("gap-coverage-context");
    await expect(context).toContainText(status);
    await expect(context).toContainText("Not confirmed yet");
    await context.getByRole("link", { name: next, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/gaps/${id}(?:#.*)?$`));
    await expect(page.getByTestId("gap-coverage-context")).toContainText(status);
    await expect(page.getByTestId("gap-coverage-context")).toContainText("Not confirmed yet");
    await expect(page.getByRole("button", { name: next === "Confirm evidence assessment" ? "Confirm evidence assessment" : "Resolve this Partially Addressed gap by splitting or rewriting", exact: true })).toBeVisible();
  }
});


test("priority drafts survive automatic placement refresh and changed saved priority revalidation", async ({ page, request }) => {
  const added = await iegpAction(request, { action: "create_gap", name: "Automatic placement refresh trigger", statement: "A new evidence need awaits placement", domain: "unmet_need", settings: "1L" });
  await iegpAction(request, { action: "validate_gap", gap_id: String(added.id) });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route("**/api/modules", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().stage === "S8") {
      started = true;
      await pending;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ summary: "Deterministic placement completion" }) });
    }
    await route.continue();
  });
  try {
    await page.goto("/?place=plan&setting=1L");
    await expect.poll(() => started).toBe(true);
    await page.getByRole("button", { name: /^Comparative panel evidence: High/ }).click();
    const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
    await panel.getByRole("button", { name: "Edit scores", exact: true }).click();
    const editor = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Save placement", exact: true }) });
    await editor.getByLabel("Priority rationale (optional)").fill("Draft rationale during automatic placement");
    await editor.getByLabel("Reason for change (required)").fill("Draft reason must survive revalidation");
    await planAction(request, { action: "set_placement", gap_id: gapId, band: "high", rationale: "Saved by a colleague while the draft is open", reason: "Concurrent priority review" });
    release();
    await expect(page.getByText("Placing new gaps on the matrix…", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("gap-panel").getByTestId("gap-priority")).toContainText("Saved by a colleague while the draft is open");
    await expect(editor.getByLabel("Priority rationale (optional)")).toHaveValue("Draft rationale during automatic placement");
    await expect(editor.getByLabel("Reason for change (required)")).toHaveValue("Draft reason must survive revalidation");
    await editor.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("Priority changed");
    await expect(editor.getByLabel("Reason for change (required)")).toHaveValue("Draft reason must survive revalidation");
    page.once("dialog", dialog => dialog.accept());
    await page.keyboard.press("Escape");
    await expect(editor).not.toBeVisible();
  } finally { release(); }
});
