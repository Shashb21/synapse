import { expect, test } from "@playwright/test";
import type { GapRecord } from "../../src/lib/iegp/gap-record";
import {
  consolidate,
  coverageOpeningTokens,
  iegpAction,
  planState,
  firstOpenGap,
  planAction,
  runStage,
  seedMapped,
  validateBandHigh,
} from "../support/synapse";
import { freshWorkspace } from "../support/session";
import { openIdeationCard } from "../support/ideation";

test.describe.configure({ mode: "serial" });

// KAN-8: Tactic Ideation from the Figma design. High-priority gaps only, as collapsible cards.
test.describe("Tactic Ideation place", () => {
  let high: { gap_id: string; name: string };
  let low: { gap_id: string; name: string } | null = null;

  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
    high = await firstOpenGap(request);
    await validateBandHigh(request, high.gap_id, "Blocks the EU5 submission, so it is High");
    low = (await consolidate(request)).open.find((row) => row.gap_id !== high.gap_id) ?? null;
    if (low) {
      await planAction(request, {
        action: "validate_band",
        gap_id: low.gap_id,
        band: "low",
        rationale: "Useful, but not this cycle",
      });
    }
  });

  test("lists only the gaps validated as High, all collapsed", async ({ page }) => {
    await page.goto("/?place=tactics");
    await expect(page.getByRole("heading", { name: /^tactic ideation$/i })).toBeVisible();
    const board = page.getByTestId("tactic-ideation");
    const toggles = board.getByTestId("ideation-gap-toggle");
    await expect(board.locator(`[data-gap-id="${high.gap_id}"]`).getByTestId("ideation-gap-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(toggles).toHaveCount(1);
    if (low) await expect(board.locator(`[data-gap-id="${low.gap_id}"]`)).toHaveCount(0);
    await expect(board.getByTestId("ideation-guide")).toContainText("Current eligible gaps: 1 shown · No candidate linked: 1 · Candidate linked: 0 · Tactic planned: 0");
    await expect(board.getByText(/other open gaps? (is|are) medium, low or not validated yet/i)).toHaveCount(0);
    await expect(page.getByText(/other open gaps? (is|are) medium, low or not validated yet/i)).toBeVisible();
  });

  test("filters by search and by whether a gap has tactics", async ({ page }) => {
    await page.goto("/?place=tactics");
    const board = page.getByTestId("tactic-ideation");
    await expect(board.getByText("1 of 1 currently eligible gaps", { exact: true })).toBeVisible();
    const search = board.getByRole("searchbox", { name: /search high-priority gaps/i });
    // Retry until the page has hydrated; typing before that changes nothing.
    await expect(async () => {
      await search.fill("");
      await search.fill("zzz-no-such-gap");
      await expect(board.getByText("No gaps match the current filters.")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await board.getByRole("combobox", { name: /filter by tactics/i }).selectOption("unlinked");
    await board.getByRole("button", { name: /^clear$/i }).click();
    await expect(board.getByTestId("ideation-gap")).toHaveCount(1);
  });

  test("collapses and expands a gap card", async ({ page }) => {
    await page.goto("/?place=tactics");
    const toggle = page.getByTestId("ideation-gap-toggle").first();
    await expect(page.getByRole("button", { name: /\+ custom tactic/i })).toHaveCount(0);
    await expect(async () => {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /\+ custom tactic/i })).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("button", { name: /\+ custom tactic/i })).toHaveCount(0);
  });

  test("a custom tactic is created and linked to the gap", async ({ page }) => {
    const name = `Custom ideation tactic ${Date.now()}`;
    await page.goto("/?place=tactics");
    await page.waitForLoadState("networkidle");
    const card = await openIdeationCard(page, high.gap_id);
    await card.getByRole("button", { name: /\+ custom tactic/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Tactic name").fill(name);
    await dialog.getByRole("combobox", { name: /tactic type/i }).selectOption("rwe_study");
    await dialog.getByPlaceholder("Evidence question").fill("Does it hold in routine care?");
    await dialog.getByRole("textbox", { name: "Reason (required)", exact: true }).fill("A new routine-care study answers the missing comparison");
    await dialog.getByRole("button", { name: /^add tactic$/i }).click();
    await expect(dialog).toBeHidden();

    // Linked tactics open the side panel (KAN-50), so the row is a button.
    await expect(card.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  });

  test("the library opens, searches, and marks unassigned tactics", async ({ page }) => {
    await page.goto("/?place=tactics");
    const library = page.getByRole("region", { name: /^tactic library$/i });
    const toggle = library.getByRole("button", { name: /tactic library/i });
    // Click only while closed: a slow retry must not close what the last click opened.
    await expect(async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect(library.getByRole("searchbox", { name: /search library/i })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await library.getByRole("searchbox", { name: /search library/i }).fill("zzz-no-such-tactic");
    await expect(library.getByText("No tactics match.")).toBeVisible();
  });
});

// KAN-8: the Gantt Timeline toolbar from the design; the chart stays editable.
test.describe("Gantt Timeline toolbar", () => {
  test("filters by priority and toggles dependency arrows", async ({ page }) => {
    await page.goto("/timeline");
    await expect(page.getByRole("heading", { name: /^gantt timeline$/i })).toBeVisible();
    const toolbar = page.getByRole("toolbar", { name: /timeline filters/i });
    await expect(toolbar).toBeVisible();
    const chart = page.locator('svg[role="img"]').first();
    const all = toolbar.getByRole("button", { name: /^all gaps$/i });
    const high = toolbar.getByRole("button", { name: /^high priority$/i });
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
      await high.click();
      await expect(high).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(chart).not.toContainText(/NOT PRIORITIZED|MEDIUM PRIORITY|LOW PRIORITY/);
    await expect(chart).toContainText("HIGH PRIORITY");
    await all.click();

    const deps = toolbar.getByRole("button", { name: /dependencies/i });
    await expect(deps).toHaveAttribute("aria-pressed", "true");
    await deps.click();
    await expect(deps).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-dependency]")).toHaveCount(0);
  });
});


test.describe("Retained tactic discovery (KAN-137)", () => {
  let gapId = "";
  freshWorkspace({ name: "KAN137 retained planning", seed: async request => {
    const created = await iegpAction(request, { action: "create_gap", name: "Retained comparison evidence", statement: "Comparative routine care survival is missing", domain: "comparative_effectiveness", settings: "1L, 2L" });
    gapId = String(created.id);
    await iegpAction(request, { action: "validate_gap", gap_id: gapId });
    await validateBandHigh(request, gapId, "The comparison blocks the committee decision");
    await iegpAction(request, { action: "complete_wizard", note: "Initial inventory reviewed" });
    await iegpAction(request, { action: "unlock_tactics", note: "Initial priorities confirmed" });
    await runStage(request, "S9", { gap_ids: [gapId], per_gap: 3 });
    const options = (await planState(request)).proposals.filter(row => row.gap_id === gapId);
    for (const [index, option] of options.entries()) await planAction(request, { action: "edit_proposal", id: option.id, expected_version: option.version, name: `Retained cohort option ${index + 1}`, rationale: "Give each alternative an inspectable distinct name" });
  } });

  test("accepted work and all alternatives remain reachable after Partial, priority changes and new Inventory work", async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const options = (await planState(request)).proposals.filter(row => row.gap_id === gapId);
    expect(options).toHaveLength(3);
    await page.goto("/?place=tactics");
    const active = await openIdeationCard(page, gapId);
    await expect(active.getByRole("button", { name: /Suggest more/ })).toBeVisible();
    for (const [index, decision, reason] of [[0, "Accept", "The cohort is feasible and covers our comparison"], [1, "Reject", "Data access prevents this alternative"]] as const) {
      const option = active.locator("article").filter({ has: page.getByRole("heading", { name: options[index].name, exact: true }) });
      await option.getByRole("button", { name: `${decision} ${options[index].name}`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `${decision} ${options[index].name}`, exact: true });
      await dialog.getByLabel("Rationale (required)").fill(reason);
      await dialog.getByRole("button", { name: `${decision} proposal`, exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await expect(active).toContainText("Accepted by");
    await expect(active).toContainText("Rejected by");
    const accepted = (await planState(request)).proposals.find(row => row.id === options[0].id)!;
    const tacticId = String(accepted.tactic_id);
    await active.getByRole("button", { name: new RegExp(`Edit ${options[0].name}`) }).click();
    const tacticPanel = page.getByRole("dialog", { name: "Tactic details", exact: true });
    const editor = tacticPanel.getByRole("form", { name: `Edit ${options[0].name}`, exact: true });
    await editor.getByRole("combobox", { name: "Status", exact: true }).selectOption("planned");
    await editor.getByLabel("Why? (required)").fill("Funding approved for the retained cohort");
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(tacticPanel).toBeHidden();
    const planned = await request.get(`/api/tactics/${tacticId}`).then(response => response.json());
    expect(planned.tactic.status).toBe("planned");
    // Planning preserves a person's earlier Open assessment; explicitly review the new coverage.
    await page.goto(`/gaps/${gapId}`);
    await page.getByRole("button", { name: "Change status of this gap (currently Open)", exact: true }).click();
    const coverageReview = page.getByRole("dialog", { name: "Override gap status", exact: true });
    await coverageReview.getByRole("button", { name: "Clear override", exact: true }).click();
    await expect(coverageReview).toBeHidden();
    await page.goto("/?place=tactics");
    const partial = await request.get(`/api/gaps/${gapId}`).then(response => response.json());
    expect(partial.coverage_status.shown).toBe("validated_partial");
    expect(partial.ideas.map((idea: { id: string }) => idea.id).sort()).toEqual(options.map(idea => idea.id).sort());
    const existing = page.getByRole("region", { name: "Existing options and planned work", exact: true });
    await expect(existing).toContainText("Retained comparison evidence");
    await expect(existing).toContainText("Partially Addressed");
    await expect(existing).toContainText("Tactic planned");
    await expect(existing).toContainText("Lifecycle: planned");
    await expect(existing).toContainText("Coverage: Not yet assessed");
    await expect(existing).toContainText("Evidence availability:");
    const trigger = existing.getByRole("link", { name: /Retained comparison evidence/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
    const ideas = panel.getByTestId("gap-ideas");
    for (const option of options) await expect(ideas).toContainText(option.name);
    await expect(ideas).toContainText("Data access prevents this alternative");
    await expect(ideas.getByRole("list", { name: "Option supporting references" }).first().getByRole("link", { name: "Retained comparison evidence", exact: true })).toHaveAttribute("href", `/gaps/${gapId}`);
    await expect(ideas).toContainText("Comparative routine care survival is missing");
    const history = panel.getByRole("group", { name: "History", exact: true });
    await expect(history).not.toHaveAttribute("open");
    await history.locator("summary").first().click();
    await expect(history).toContainText("The cohort is feasible and covers our comparison");
    const linkedTactic = panel.getByRole("region", { name: "Linked tactics", exact: true }).getByRole("link", { name: options[0].name, exact: true });
    let tacticUnavailable = true;
    await page.route(`**/api/tactics/${tacticId}`, route => tacticUnavailable
      ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unavailable record" }) })
      : route.continue());
    await linkedTactic.click();
    await expect(tacticPanel.getByRole("alert")).toContainText("missing or unavailable");
    await expect(tacticPanel.getByRole("link", { name: "Open full record", exact: true })).toHaveAttribute("href", `/tactics/${tacticId}`);
    await tacticPanel.getByRole("button", { name: "Back to gap", exact: true }).click();
    await expect(linkedTactic).toBeFocused();
    await expect(history).toHaveAttribute("open", "");
    tacticUnavailable = false;
    await linkedTactic.click();
    await expect(tacticPanel).toContainText("planned");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(tacticPanel.getByRole("button", { name: "Back to gap", exact: true })).toBeFocused();
    await expect(tacticPanel.getByRole("link", { name: "Open full record", exact: true })).toHaveAttribute("href", `/tactics/${tacticId}`);
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await existing.screenshot({ path: testInfo.outputPath("retained-partial-work.png") });
    await page.screenshot({ path: testInfo.outputPath("kan123-desktop-planning.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(existing.getByTestId("linked-planning-facts").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("kan123-mobile-planning.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    // Priority editing serves Open gaps. Reopen through the existing relationship editor first.
    const initialLink = planned.coverages.find((row: { gap_id: string }) => row.gap_id === gapId);
    await iegpAction(request, { action: "lock_overall", coverage_id: initialLink.id, expected_relationship: initialLink.relationship_version, expected_version: initialLink.review_version, overall: "not_relevant", rationale: "Review shows this cohort does not cover the remaining comparison" });
    for (const band of ["medium", "low"] as const) {
      await planAction(request, { action: "set_placement", gap_id: gapId, band, validate: true, rationale: `Review the ${band} priority after initial planning`, reason: "Evidence planning priorities have changed" });
      await page.reload();
      await expect(existing).toContainText(band === "medium" ? "Medium" : "Low");
      await expect(page.locator(`[data-testid="ideation-gap"][data-gap-id="${gapId}"]`)).toHaveCount(0);
      await trigger.click();
      await expect(panel.getByTestId("gap-planning-routes")).toContainText("manual");
      await expect(panel.getByTestId("gap-planning-routes").getByRole("link", { name: "Map from library or add a tactic by hand", exact: true })).toHaveAttribute("href", `/gaps/${gapId}#gap-tactic-mappings`);
      await expect(ideas).toContainText(options[2].name);
      await page.keyboard.press("Escape");
    }
    const reused = await iegpAction(request, { action: "create_gap", name: "Second decision using the cohort", statement: "A second population needs evidence", domain: "unmet_need" });
    await page.goto(`/gaps/${reused.id}#gap-tactic-mappings`);
    await page.getByRole("button", { name: "Map existing tactic", exact: true }).click();
    const reuse = page.getByRole("dialog", { name: "Map existing tactic", exact: true });
    await reuse.getByRole("combobox", { name: "From tactic library", exact: true }).selectOption(tacticId);
    await reuse.getByRole("combobox", { name: "How well it covers this gap" }).selectOption("partial");
    await reuse.getByLabel("Reason (required)").fill("Reuse the cohort for this separate population");
    await reuse.getByRole("button", { name: "Map tactic", exact: true }).click();
    await expect(reuse).toBeHidden();
    await iegpAction(request, { action: "create_gap", name: "New unresolved Inventory work", statement: "New evidence needs review", domain: "unmet_need" });
    // This synthetic positive fixture must review requirements and dimensions before Full.
    let reviewed: GapRecord = await request.get(`/api/gaps/${gapId}`).then(response => response.json());
    await iegpAction(request, {
      action: "review_requirement_basis", gap_id: gapId,
      expected_version: reviewed.requirement_review.version,
      requirements: JSON.stringify(Object.fromEntries(Object.entries(reviewed.requirement_review.basis.dimensions).map(([dimension, requirement]) => [dimension, {
        applicability: requirement.requirement.trim() ? "required" : "not_applicable",
        requirement: requirement.requirement,
        rationale: "Synthetic discovery fixture: sourced requirements are required; unspecified dimensions are outside this fixture's decision",
        resolution: requirement.conflicts.length ? "Fixture reviewer requires the combined sourced requirements" : "",
      }]))),
      rationale: "Explicit requirement review for the positive retained-discovery fixture",
    });
    reviewed = await request.get(`/api/gaps/${gapId}`).then(response => response.json());
    for (const [dimension, requirement] of Object.entries(reviewed.requirement_review.basis.dimensions)) {
      if (requirement.applicability !== "required") continue;
      const current: GapRecord = await request.get(`/api/gaps/${gapId}`).then(response => response.json());
      const coverage = current.coverages.find(row => row.tactic_id === tacticId)!;
      await iegpAction(request, {
        action: "lock_dimension", coverage_id: coverage.id, dimension, value: "yes",
        ...await coverageOpeningTokens(request, tacticId, coverage.id),
        rationale: "Synthetic positive fixture: the retained design satisfies this sourced requirement",
      });
    }
    reviewed = await request.get(`/api/gaps/${gapId}`).then(response => response.json());
    const coverage = reviewed.coverages.find(row => row.tactic_id === tacticId)!;
    await iegpAction(request, {
      action: "lock_overall", coverage_id: coverage.id,
      ...await coverageOpeningTokens(request, tacticId, coverage.id), expected_basis_version: reviewed.requirement_review.version,
      overall: "full", rationale: "The reviewed evidence now addresses this comparison",
    });
    await page.goto("/?place=tactics");
    await expect(existing).toContainText("Addressed");
    await expect(existing).toContainText("Coverage: Full");
    await expect(existing).toContainText("Human confirmation: Confirmed by");
    await expect(existing).toContainText("Lifecycle: planned");
    await expect(existing).toContainText("Second decision using the cohort");
    await expect(page.getByRole("button", { name: /Tactic Library/ })).toBeVisible();
    await trigger.click();
    await expect(ideas).toContainText(options[0].name);
    await panel.getByRole("link", { name: "Open full record", exact: true }).click();
    await expect(page.getByTestId("gap-ideas")).toContainText(options[1].name);
    const final = await request.get(`/api/tactics/${tacticId}`).then(response => response.json());
    expect(final.tactic.id).toBe(tacticId);
    expect(new Set(final.coverages.map((row: { gap_id: string }) => row.gap_id))).toEqual(new Set([gapId, String(reused.id)]));
    expect((await planState(request)).proposals.filter(row => row.gap_id === gapId).map(row => row.id).sort()).toEqual(options.map(row => row.id).sort());
  });

  test("changed-context review retains option inspection, filters and retry before renewed High confirmation", async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const added = await iegpAction(request, { action: "create_gap", name: "Renewed review comparison", statement: "Short-term evidence is missing", domain: "comparative_effectiveness", settings: "1L, 2L" });
    const reviewedId = String(added.id);
    await validateBandHigh(request, reviewedId, "The comparison still affects the committee decision");
    await planAction(request, { action: "add_proposal", gap_id: reviewedId, name: "Existing review option", type: "rwe_study", evidence_question: "What is comparative survival?", rationale: "Keep the earlier option available during review" });
    await page.goto(`/gaps/${reviewedId}`);
    await page.getByRole("button", { name: `Edit ${reviewedId}`, exact: true }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${reviewedId}`, exact: true });
    await edit.getByRole("textbox", { name: "Evidence needed (required)", exact: true }).fill("Long-term comparative evidence is missing");
    await edit.getByLabel("Rationale (required)").fill("The committee now needs a longer follow-up comparison");
    await edit.getByRole("button", { name: "Save edit", exact: true }).click();
    await expect(edit).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?place=tactics");
    const search = page.getByRole("searchbox", { name: /Search high-priority gaps/ });
    await search.fill("Renewed review");
    await expect(page.getByText(/^0 of \d+ currently eligible gaps$/)).toBeVisible();
    const existing = page.getByRole("region", { name: "Existing options and planned work", exact: true });
    await expect(existing).toContainText("Needs priority review");
    await expect(page.locator(`[data-testid="ideation-gap"][data-gap-id="${reviewedId}"]`)).toHaveCount(0);
    const run = await runStage<{ gaps_considered: number }>(request, "S9", { gap_ids: [reviewedId] });
    expect(run.output.gaps_considered).toBe(0);
    const trigger = existing.getByRole("link", { name: /Renewed review comparison/ });
    let failing = true;
    await page.route(`**/api/gaps/${reviewedId}`, route => failing
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Temporary detail failure" }) })
      : route.continue());
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Gap details", exact: true });
    await expect(panel.getByRole("alert")).toContainText("could not be loaded");
    failing = false;
    await panel.getByRole("button", { name: "Retry gap details", exact: true }).click();
    await expect(panel.getByTestId("gap-ideas")).toContainText("Existing review option");
    await expect(panel.getByTestId("gap-planning-routes")).toContainText("Review changed context and revalidate a High/Open priority before new AI ideation.");
    await expect(panel.getByTestId("gap-priority")).toContainText("Priority applies across all settings");
    const bounds = await panel.boundingBox();
    expect(bounds!.width).toBeCloseTo(390, 2);
    expect(bounds!.height).toBeCloseTo(844, 2);
    await panel.screenshot({ path: testInfo.outputPath("retained-review-options.png") });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(search).toHaveValue("Renewed review");
    await page.goto("/ideation");
    const group = page.locator("section").filter({ has: page.getByRole("link", { name: "Renewed review comparison", exact: true }) }).first();
    await expect(group).toContainText("Existing options and planned work");
    await expect(group.getByRole("button", { name: "Add idea by hand", exact: true })).toHaveCount(0);
    await validateBandHigh(request, reviewedId, "Reviewed the changed context and retained High");
    await page.goto("/?place=tactics");
    const active = await openIdeationCard(page, reviewedId);
    await expect(active.getByRole("button", { name: "Suggest more", exact: true })).toBeVisible();
    await expect(active).toContainText("Existing review option");
  });
});
