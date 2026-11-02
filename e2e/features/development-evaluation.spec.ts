/** Saved-output evaluations use scripted durable replies and never call a paid provider. */
import { expect, test, type Page } from "@playwright/test";
import { balancedProfile, type EvaluationProfile } from "../../src/modules/development/profile-schema";
import { evaluationConfigSchema } from "../../src/modules/development/evaluation-schema";
import type { Experiment } from "../../src/modules/development/schema";

/** Create real isolated source/reference snapshots, while scripting generation and evaluator I/O. */
async function arrange(page: Page, options: { queuedSpendingPause?: boolean; malformed?: boolean; missingDelivery?: boolean; profileLoadFailure?: boolean; pollFailure?: boolean; twoExecutions?: boolean; holdEvaluationNumber?: number; recoveryHistoryFailure?: boolean; firstQueueFailure?: { status: number; code: string }; holdQueuedHistory?: boolean; holdSucceededHistory?: boolean; paginated?: boolean } = {}) {
  const name = `Evaluation ${Date.now()}`;
  const created = await page.request.post("/api/admin/development", { data: { name, source_workspace_id: null } });
  expect(created.ok(), `Create experiment: ${created.status()} ${await created.text()}`).toBe(true);
  let draft: Experiment = (await created.json()).experiment;
  const uploaded = await page.request.post(`/api/admin/development/${draft.id}/source-upload`, { data: { revision: draft.revision, filename: "evaluation-source.txt", content_base64: Buffer.from("Comparative outcomes remain uncertain.").toString("base64") } });
  expect(uploaded.ok()).toBe(true);
  draft = (await uploaded.json()).experiment;
  const source = draft.documents[0];
  const referenceResponse = await page.request.post(`/api/admin/development/${draft.id}/reference-upload`, { data: { revision: draft.revision, filename: "evaluation-reference.json", format: "structured", section: "gap_extraction", source_document_ids: [source.id], content_base64: Buffer.from(JSON.stringify({ version: 1, section: "gap_extraction", source_document_ids: [source.id], expected_answers: [{ id: "answer-1", source_document_id: source.id, statement: "Comparative evidence is missing.", quote: "Comparative outcomes remain uncertain." }] })).toString("base64") } });
  expect(referenceResponse.ok()).toBe(true);
  draft = (await referenceResponse.json()).experiment;
  const reference = draft.documents.find((item) => item.role === "reference")!;
  let profileLoadFailure = !!options.profileLoadFailure;
  let recoveryHistoryFailure = !!options.recoveryHistoryFailure;
  let historyMode: "all" | "empty" | "older" = "all";
  const profiles: EvaluationProfile[] = [structuredClone(balancedProfile)];
  const saves: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  let generationPosts = 0;
  let polls = 0;
  let releaseExecutions!: () => void;
  const executionResponse = new Promise<void>((resolve) => { releaseExecutions = resolve; });
  let releaseEvaluation!: () => void;
  let releasedResponse = false;
  const firstEvaluationResponse = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
  const config = evaluationConfigSchema.parse({});
  const output = { output_id: "a".repeat(64), output: { accepted: [], rejected: [{ reason: "Internal acceptance failed" }] }, candidates: [{ statement: "Comparative evidence is missing." }], reason: null };
  const generation = { revision: draft.revision, config: { mode: "standard", evaluator: config.sections.gap_extraction.route }, routes: {}, sources: [source] };
  const cost = options.queuedSpendingPause ? { execution_id: "saved-run", currency: "USD", allowance_usd: 2, unknown_acknowledged: false, override_enabled: false, paused: false, pause_reason: "", estimate: { total_usd: null, uncertainty: [] }, reserved_usd: 0, generation_usage_usd: 0.12, evaluation_usage_usd: 0, unknown_usage_calls: 0, unknown_active_reservations: 0, reported_total: null, events: [], reservations: [] } : undefined;
  const execution = { cost, id: "saved-run", experiment_id: draft.id, created_at: "2026-10-30", updated_at: "2026-10-30", generation_status: "succeeded", evaluation_status: "not_requested", error: null, manifest: generation, sections: [{ id: "saved-attempt", section: "gap_extraction", status: "rejected", result: output, error: null, prerequisites: {} }], calls: [] };
  const evaluations: Record<string, unknown>[] = [];
  let releaseQueuedHistory!: () => void;
  let queuedHistoryHeld!: () => void;
  const queuedHistoryRelease = new Promise<void>((resolve) => { releaseQueuedHistory = resolve; });
  const queuedHistoryStarted = new Promise<void>((resolve) => { queuedHistoryHeld = resolve; });
  let held = false;
  let releaseSucceededHistory!: () => void;
  let succeededHistoryHeld!: () => void;
  const succeededHistoryRelease = new Promise<void>((resolve) => { releaseSucceededHistory = resolve; });
  const succeededHistoryStarted = new Promise<void>((resolve) => { succeededHistoryHeld = resolve; });
  await page.route(`**/api/admin/development/${draft.id}/executions**`, async (route) => {
    if (route.request().method() === "POST") generationPosts++;
    if (options.profileLoadFailure) await executionResponse;
    const snapshot = structuredClone(evaluations);
    const olderPage = new URL(route.request().url()).searchParams.has("cursor");
    if (options.holdSucceededHistory && !held && !olderPage && snapshot.some(item => item.status === "succeeded")) {
      held = true; succeededHistoryHeld(); await succeededHistoryRelease;
    }
    if (options.holdQueuedHistory && !held && snapshot.some(item => item.status === "queued")) {
      held = true; queuedHistoryHeld(); await queuedHistoryRelease;
    }
    await route.fulfill({ json: { executions: olderPage ? [{ ...execution, id: "older-run", sections: [{ ...execution.sections[0], id: "older-attempt" }] }] : options.twoExecutions ? [execution, { ...execution, id: "other-run", cost: cost ? { ...cost, execution_id: "other-run", paused: false, pause_reason: "", evaluation_usage_usd: 0 } : undefined, sections: [{ ...execution.sections[0], id: "other-attempt", result: { ...output, output_id: "b".repeat(64) } }] }] : [execution], next_cursor: options.paginated && !olderPage ? "older-cursor" : null, delivery: { available: true, reason: null }, history: olderPage ? { "older-attempt": { freshness: { current: true, reasons: [] }, evaluations: [] } } : { "saved-attempt": { freshness: { current: true, reasons: [] }, evaluations: snapshot.filter(item => (item.manifest as { attempt_id: string }).attempt_id === "saved-attempt").map(item => ({ id: item.id, status: item.status, freshness: "unavailable", reasons: [], profile_id: "balanced", output_id: output.output_id, evaluator_identity: "settings", reference_identity: "references", reference_ids: [] })) } } } });
  });
  await page.route(`**/api/admin/development/${draft.id}/profiles`, async (route) => {
    if (route.request().method() === "GET" && profileLoadFailure) { await route.fulfill({ status: 503, json: { error: "Profile service unavailable. Reload evaluation data." } }); return; }
    if (route.request().method() === "GET") { await route.fulfill({ json: { profiles, default_profile: { id: "balanced", version: 1 } } }); return; }
    const body = route.request().postDataJSON(); saves.push(body);
    const profile = { name: body.name, defaults: body.defaults, sections: body.sections, id: body.profile_id ?? "custom-profile", version: body.base_version ? body.base_version + 1 : 1, builtin: false, created_at: "2026-10-30" };
    profiles.push(profile);
    await route.fulfill({ status: 201, json: { profile } });
  });
  await page.route(`**/api/admin/development/${draft.id}/evaluations`, async (route) => {
    if (route.request().method() === "GET") {
      if (posts.length >= (options.holdEvaluationNumber ?? 1) && recoveryHistoryFailure) { await route.fulfill({ status: 503, json: { error: "Saved history unavailable. Reload evaluation data." } }); return; }
      await route.fulfill({ json: { evaluations: historyMode === "empty" ? [] : historyMode === "older" ? evaluations.slice(1) : evaluations, delivery: { available: !options.missingDelivery, reason: options.missingDelivery ? "Worker is not configured." : null } } }); return; }
    const body = route.request().postDataJSON(); posts.push(body);
    if (options.firstQueueFailure && posts.length === 1) {
      await route.fulfill({ status: options.firstQueueFailure.status, json: { code: options.firstQueueFailure.code, error: "The evaluation request was rejected. Correct the selection or settings." } });
      return;
    }
    const profile = profiles.find((item) => item.id === body.profile_id && item.version === body.profile_version)!;
    const selectedReferences = body.reference_ids.length ? [reference] : [];
    const evaluation = { id: `evaluation-${posts.length}`, experiment_id: draft.id, created_at: "2026-10-30", updated_at: "2026-10-30", status: "queued", error: null, result: null, receipt: null, failure_accounting: null, manifest: { execution_id: body.execution_id, attempt_id: body.attempt_id, output_id: body.output_id, section: "gap_extraction", profile, criteria: profile.defaults, config: body.config, route: null, generation, output, sources: [source], references: selectedReferences, reference_items: [], reference_issues: [], reference_requested: !!selectedReferences.length } };
    evaluations.unshift(evaluation);
    if (posts.length === options.holdEvaluationNumber) {
      await firstEvaluationResponse;
      await route.fulfill({ status: 202, json: { evaluation } });
      releasedResponse = true;
      return;
    }
    await route.fulfill({ status: 202, json: { evaluation } });
  });
  await page.route(`**/api/admin/development/${draft.id}/evaluations/*`, async (route) => {
    polls++;
    if (options.pollFailure && polls === 1) { await route.fulfill({ status: 503, json: { error: "Temporary progress outage. Reload evaluation data." } }); return; }
    const id = route.request().url().split("/").pop();
    const evaluation = evaluations.find((item) => item.id === id)!;
    if (options.queuedSpendingPause && cost) {
      cost.paused = true; cost.pause_reason = "Evaluator allowance exhausted.";
      cost.evaluation_usage_usd = Number((polls * 0.03).toFixed(2));
      Object.assign(evaluation, { cost: structuredClone(cost) });
      await route.fulfill({ json: { evaluation } });
      return;
    }
    const manifest = evaluation.manifest as { references: unknown[]; profile: EvaluationProfile };
    Object.assign(evaluation, options.malformed ? { status: "failed", error: "Evaluator reply has an out-of-range score.", receipt: { llm_call_id: "trace-1", text: "malformed", usage: null, cost_usd: 0 } } : { status: "succeeded", result: { checks: { passed: false, items: [{ id: "quotation", passed: false, detail: "Quotation requires inspection." }] }, rubric: { score: 3, criteria: manifest.profile.defaults.map((criterion) => ({ criterion_id: criterion.id, score: 3, reason: "Source-supported assessment.", threshold_met: null })) }, reference: { status: manifest.references.length ? "scored" : "unscored", reasons: manifest.references.length ? [] : ["No reference documents selected."], precision: { numerator: 1, denominator: 1, value: manifest.references.length ? 1 : null }, recall: { numerator: 1, denominator: 1, value: manifest.references.length ? 1 : null }, matches: manifest.references.length ? [{ output_id: "candidate:0", reference_id: `${reference.id}:answer-1`, reason: "Same question." }] : [], unmatched_output_ids: [], unmatched_reference_ids: [] } } });
    await route.fulfill({ json: { evaluation } });
  });
  await page.goto("/admin/development");
  await page.getByRole("button", { name: `Open ${name}` }).click();
  if (!options.profileLoadFailure) await expect(page.getByRole("region", { name: "Evaluation", exact: true }).getByRole("button", { name: "Save As custom profile" })).toBeEnabled();
  return { name, draft, reference, saves, posts, releaseExecutions, releaseEvaluation, releasedResponse: () => releasedResponse, recoverProfiles: () => { profileLoadFailure = false; }, recoverHistory: (mode: "all" | "empty" | "older" = "all") => { recoveryHistoryFailure = false; historyMode = mode; }, releaseQueuedHistory, queuedHistoryStarted, releaseSucceededHistory, succeededHistoryStarted, generationPosts: () => generationPosts, polls: () => polls };
}

test("copies and versions profiles, evaluates a retained rejected output and reopens immutable history", async ({ page }) => {
  // Arrange: saved generation and provisional reference snapshots exist before opening the editor.
  const fixture = await arrange(page);
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await expect(panel.getByText("Balanced · balanced@1 · read-only")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save As custom profile" })).toBeEnabled();
  await panel.getByText("Profile criteria and anchors", { exact: true }).click();
  await expect(panel.getByLabel("Profile name", { exact: true })).toBeDisabled();
  // Act: keyboard-copy the immutable built-in, validate numeric input, then save append-only versions.
  await panel.getByRole("button", { name: "Save As custom profile" }).focus();
  await page.keyboard.press("Enter");
  await panel.getByLabel("Profile name", { exact: true }).fill("Clinical recovery");
  const criterion = panel.getByRole("group", { name: "Criterion 1", exact: true });
  await criterion.getByLabel("Weight", { exact: true }).fill("-1");
  await panel.getByRole("button", { name: "Save new profile" }).click();
  await expect(panel.getByRole("alert")).toContainText("weight");
  expect(fixture.saves).toHaveLength(0);
  await criterion.getByLabel("Weight", { exact: true }).fill("2");
  await criterion.getByLabel("Threshold (optional)", { exact: true }).fill("3");
  await criterion.getByLabel("Criterion ID", { exact: true }).fill("clinical_recovery");
  await criterion.getByLabel("Name", { exact: true }).fill("Clinical finding recovery");
  await criterion.getByRole("textbox", { name: "Definition", exact: true }).fill("Recover the relevant clinical questions.");
  await criterion.getByRole("textbox", { name: "Instructions", exact: true }).fill("Explain each score using the source.");
  await criterion.getByRole("textbox", { name: "Anchor 4", exact: true }).fill("Every relevant clinical question recovered.");
  await panel.getByRole("button", { name: "Save new profile" }).click();
  await expect(panel.getByText("Clinical recovery · custom-profile@1 · saved version")).toBeVisible();
  await criterion.getByLabel("Weight", { exact: true }).fill("3");
  await panel.getByLabel("Criteria scope").selectOption("tactic_extraction");
  await panel.getByLabel("Use section-specific criteria for Tactic extraction").check();
  await criterion.getByLabel("Name", { exact: true }).fill("Tactic-specific recovery");
  await panel.getByRole("button", { name: "Save new version" }).click();
  await expect(panel.getByText("Clinical recovery · custom-profile@2 · saved version")).toBeVisible();
  expect(fixture.saves[1]).toMatchObject({ base_version: 1, sections: { tactic_extraction: [{ name: "Tactic-specific recovery" }, {}, {}, {}, {}] } });
  await panel.getByText("Per-section evaluator settings", { exact: true }).click();
  const gaps = panel.getByRole("group", { name: "Gap extraction evaluator", exact: true });
  const tactics = panel.getByRole("group", { name: "Tactic extraction evaluator", exact: true });
  await gaps.getByLabel("Method").selectOption("rubric_and_reference");
  await tactics.getByLabel("Method").selectOption("checks_only");
  await gaps.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await panel.getByLabel(new RegExp(`Use evaluation-reference.json`)).check();
  await panel.getByLabel("Additional evaluation allowance (USD)").fill("4");
  await panel.getByLabel(/I acknowledge unknown provider charges/).check();
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  // Assert: durable progress yields separate results; exact snapshots and reference review state remain visible.
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText("Factual checks: failed", { exact: true })).toBeVisible();
  await expect(panel.getByText("Provisional AI assessment: 3.00 / 4", { exact: true })).toBeVisible();
  await expect(panel.getByText("Provisional reference measures: scored", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Precision: 1\/1/)).toBeVisible();
  await expect(panel.getByText(/Recall: 1\/1/)).toBeVisible();
  await expect(panel.getByText(/Reference snapshot: evaluation-reference.json/).filter({ visible: true })).toContainText(fixture.reference.review_status);
  expect(fixture.posts[0]).toMatchObject({ execution_id: "saved-run", attempt_id: "saved-attempt", output_id: "a".repeat(64), profile_id: "custom-profile", profile_version: 2, reference_ids: [fixture.reference.id], config: { sections: { gap_extraction: { method: "rubric_and_reference", route: { provider_id: "openai" } }, tactic_extraction: { method: "checks_only" } } } });
  await panel.getByLabel(new RegExp(`Use evaluation-reference.json`)).uncheck();
  expect(fixture.posts[0].cost_controls).toEqual({ allowance_usd: 4, unknown_acknowledged: true });
  await panel.getByLabel("Additional evaluation allowance (USD)").fill("1.5");
  await panel.getByRole("button", { name: "Re-evaluate saved output", exact: true }).click();
  await expect(panel.getByText("Provisional reference measures: unscored", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText("No reference documents selected.", { exact: true })).toBeVisible();
  expect(fixture.posts[1].cost_controls).toEqual({ allowance_usd: 1.5, unknown_acknowledged: true });
  expect(fixture.generationPosts()).toBe(0);
  expect(fixture.polls()).toBe(2);
  await panel.getByLabel("Selected evaluation").selectOption("evaluation-1");
  await expect(panel.getByText("Provisional reference measures: scored", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: `Open ${fixture.name}` }).click();
  await panel.getByLabel("Selected evaluation").selectOption("evaluation-1");
  await expect(panel.getByText("Frozen profile: Clinical recovery · custom-profile@2")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".superpowers/sdd/2026-10-30-kan204/task-2-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".superpowers/sdd/2026-10-30-kan204/task-2-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("keeps malformed evaluator failures separate from successful generation without automatic resend", async ({ page }) => {
  // Arrange: a provider receipt settles, then bounded reply validation fails.
  const fixture = await arrange(page, { malformed: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  // Act: evaluate only the persisted output.
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  // Assert: failure is inspectable, generation remains successful, and no resend occurs.
  await expect(panel.getByText("Evaluation status: failed", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText("Evaluator reply has an out-of-range score.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Generation: succeeded/)).toBeVisible();
  await expect(panel.getByText(/No automatic resend/)).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.generationPosts()).toBe(0);
});

test("blocks checks-only work when durable delivery is unavailable", async ({ page }) => {
  // Arrange: every evaluation method requires durable worker delivery.
  const fixture = await arrange(page, { missingDelivery: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  // Act: select provider-free checks.
  await panel.getByText("Per-section evaluator settings", { exact: true }).click();
  await panel.getByRole("group", { name: "Gap extraction evaluator", exact: true }).getByLabel("Method").selectOption("checks_only");
  // Assert: the UI fails closed before queuing any job.
  await expect(panel.getByText(/Evaluation delivery unavailable: Worker is not configured/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Evaluate saved output", exact: true })).toBeDisabled();
  expect(fixture.posts).toHaveLength(0);
});


test("reloads usable profiles after an initial load failure", async ({ page }) => {
  // Arrange: an unavailable profile service leaves no selected profile or draft.
  const fixture = await arrange(page, { profileLoadFailure: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await expect(panel.getByRole("alert")).toContainText("Profile service unavailable");
  // Select the initial execution only after the experiment-level loading error is visible.
  fixture.releaseExecutions();
  await expect(page.getByLabel("Selected execution")).toHaveValue("saved-run");
  await expect(panel.getByRole("alert")).toContainText("Profile service unavailable");
  await expect(panel.getByRole("button", { name: "Reload evaluation data" })).toBeEnabled();
  // Act: restore service and explicitly reload authoritative state.
  fixture.recoverProfiles();
  await panel.getByRole("button", { name: "Reload evaluation data" }).click();
  // Assert: recovery restores an editable selection without a generation request.
  await expect(panel.getByText("Balanced · balanced@1 · read-only")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save As custom profile" })).toBeEnabled();
  expect(fixture.generationPosts()).toBe(0);
});


test("resumes active evaluation polling after a transient failure and reload", async ({ page }) => {
  // Arrange: the first progress request fails while the durable job stays queued.
  const fixture = await arrange(page, { pollFailure: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Temporary progress outage", { timeout: 10000 });
  // Act: reload succeeds but returns the same active status.
  await panel.getByRole("button", { name: "Reload evaluation data" }).click();
  await expect(panel.getByText("Evaluation status: queued", { exact: true })).toBeVisible();
  // Assert: progress continues to terminal state without another provider dispatch.
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByRole("button", { name: "Re-evaluate saved output", exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.generationPosts()).toBe(0);
});

test("preserves unsaved profile and independent evaluator settings across execution switches", async ({ page }) => {
  // Arrange: a dirty experiment-scoped profile and section routes are not saved yet.
  const fixture = await arrange(page, { twoExecutions: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await panel.getByRole("button", { name: "Save As custom profile" }).click();
  await panel.getByText("Profile criteria and anchors", { exact: true }).click();
  await panel.getByLabel("Profile name", { exact: true }).fill("Unsaved experiment rubric");
  await panel.getByRole("group", { name: "Criterion 1", exact: true }).getByRole("textbox", { name: "Anchor 4", exact: true }).fill("Retain this unsaved anchor.");
  await panel.getByLabel("Criteria scope").selectOption("tactic_extraction");
  await panel.getByLabel("Use section-specific criteria for Tactic extraction").check();
  await panel.getByRole("group", { name: "Criterion 1", exact: true }).getByLabel("Name", { exact: true }).fill("Unsaved tactic criterion");
  await panel.getByText("Per-section evaluator settings", { exact: true }).click();
  const gaps = panel.getByRole("group", { name: "Gap extraction evaluator", exact: true });
  await gaps.getByLabel("Method").selectOption("rubric_and_reference");
  await gaps.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await panel.getByRole("group", { name: "Tactic extraction evaluator", exact: true }).getByLabel("Method").selectOption("checks_only");
  await panel.getByLabel(new RegExp("Use evaluation-reference.json")).check();
  await panel.getByLabel("Additional evaluation allowance (USD)").fill("7");
  await panel.getByLabel(/I acknowledge unknown provider charges/).check();
  // Act: inspect another saved execution and return.
  await page.getByLabel("Selected execution").selectOption("other-run");
  await expect(panel.getByText(/Execution: other-run · Attempt: other-attempt/)).toBeVisible();
  await page.getByLabel("Selected execution").selectOption("saved-run");
  await expect(panel.getByLabel("Additional evaluation allowance (USD)")).toHaveValue("0");
  await expect(panel.getByLabel(/I acknowledge unknown provider charges/)).not.toBeChecked();
  // Assert: editor draft and each section's settings survive; output-specific references reset.
  await expect(panel.getByLabel("Profile name", { exact: true })).toHaveValue("Unsaved experiment rubric");
  await expect(panel.getByLabel("Criteria scope")).toHaveValue("tactic_extraction");
  await expect(panel.getByRole("group", { name: "Criterion 1", exact: true }).getByLabel("Name", { exact: true })).toHaveValue("Unsaved tactic criterion");
  await panel.getByLabel("Criteria scope").selectOption("defaults");
  await expect(panel.getByRole("group", { name: "Criterion 1", exact: true }).getByRole("textbox", { name: "Anchor 4", exact: true })).toHaveValue("Retain this unsaved anchor.");
  await expect(gaps.getByLabel("Method")).toHaveValue("rubric_and_reference");
  await expect(gaps.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("openai");
  await expect(panel.getByRole("group", { name: "Tactic extraction evaluator", exact: true }).getByLabel("Method")).toHaveValue("checks_only");
  await expect(panel.getByLabel(new RegExp("Use evaluation-reference.json"))).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Evaluate saved output", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Save new profile" }).click();
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  expect(fixture.posts[0]).toMatchObject({ execution_id: "saved-run", attempt_id: "saved-attempt", output_id: "a".repeat(64), config: { sections: { gap_extraction: { method: "rubric_and_reference", route: { provider_id: "openai" } }, tactic_extraction: { method: "checks_only" } } } });
  expect(fixture.saves[0]).toMatchObject({ name: "Unsaved experiment rubric", sections: { tactic_extraction: [{ name: "Unsaved tactic criterion" }, {}, {}, {}, {}] } });
});

test("refreshes an active evaluation while a completed history record is selected", async ({ page }) => {
  // Arrange: retain a completed evaluation, then queue a second attempt.
  const fixture = await arrange(page);
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  await panel.getByRole("button", { name: "Re-evaluate saved output", exact: true }).click();
  // Act: inspect immutable older history while the second job is active.
  await panel.getByLabel("Selected evaluation").selectOption("evaluation-1");
  // Assert: unselected progress still refreshes and releases the output lock.
  await expect(panel.getByLabel("Selected evaluation").locator('option[value="evaluation-2"]')).toContainText("succeeded", { timeout: 10000 });
  await expect(panel.getByLabel("Selected evaluation")).toHaveValue("evaluation-1");
  await expect(panel.getByRole("button", { name: "Re-evaluate saved output", exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(2);
  expect(fixture.generationPosts()).toBe(0);
});


test("reconciles an interrupted queue response before allowing the original output again", async ({ page }) => {
  // Arrange: the server saves the evaluation before its queue response reaches the browser.
  const fixture = await arrange(page, { twoExecutions: true, holdEvaluationNumber: 1 });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  const cancelled = page.waitForEvent("requestfailed", { predicate: (request) => request.method() === "POST" && request.url().endsWith(`/development/${fixture.draft.id}/evaluations`) });
  // Act: switch away before the response, then immediately inspect the original output again.
  await page.getByLabel("Selected execution").selectOption("other-run");
  await cancelled;
  await page.getByLabel("Selected execution").selectOption("saved-run");
  // Assert: authoritative history recovers the retained job; the active original output stays locked.
  await expect(panel.getByLabel("Selected evaluation")).toHaveValue("evaluation-1");
  await expect(panel.getByRole("button", { name: "Re-evaluate saved output", exact: true })).toBeDisabled();
  expect(fixture.posts).toHaveLength(1);
  fixture.releaseEvaluation();
  await expect.poll(() => fixture.releasedResponse()).toBe(true);
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  // Another output remains independently evaluable through an explicit owner action.
  await page.getByLabel("Selected execution").selectOption("other-run");
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect(panel.getByText(`Frozen output: ${"b".repeat(64)}`, { exact: false })).toBeVisible();
  expect(fixture.posts).toHaveLength(2);
  expect(fixture.posts[1]).toMatchObject({ execution_id: "other-run", attempt_id: "other-attempt", output_id: "b".repeat(64) });
  expect(fixture.generationPosts()).toBe(0);
});

test("keeps an uncertain original output locked after failed, empty or older history recovery", async ({ page }) => {
  // Arrange: a durable write succeeds but the response and subsequent history read are unavailable.
  const fixture = await arrange(page, { twoExecutions: true, holdEvaluationNumber: 2, recoveryHistoryFailure: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  await panel.getByRole("button", { name: "Re-evaluate saved output", exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(2);
  await page.getByLabel("Selected execution").selectOption("other-run");
  await expect(panel.getByRole("alert")).toContainText("Saved history unavailable");
  await page.getByLabel("Selected execution").selectOption("saved-run");
  // Act: even an empty successful read cannot prove that an interrupted POST did not persist.
  await expect(panel.getByRole("button", { name: /^(Re-evaluate|Evaluate) saved output$/ })).toBeDisabled();
  await expect(panel.getByText(/The queue request for this output has an uncertain outcome/)).toBeVisible();
  fixture.recoverHistory("empty");
  await panel.getByRole("button", { name: "Reload evaluation data" }).click();
  await expect(panel.getByText(/Evaluation data reloaded/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /^(Re-evaluate|Evaluate) saved output$/ })).toBeDisabled();
  expect(fixture.posts).toHaveLength(2);
  // An older terminal evaluation of this exact output is not the interrupted new request.
  fixture.recoverHistory("older");
  await panel.getByRole("button", { name: "Reload evaluation data" }).click();
  await expect(panel.getByLabel("Selected evaluation")).toHaveValue("evaluation-1");
  await expect(panel.getByRole("button", { name: "Re-evaluate saved output", exact: true })).toBeDisabled();
  // Assert: only finding the new matching evaluation resolves uncertainty; no automatic resend.
  fixture.recoverHistory();
  await panel.getByRole("button", { name: "Reload evaluation data" }).click();
  await expect(panel.getByLabel("Selected evaluation").locator('option[value="evaluation-2"]')).toContainText("queued");
  await expect(panel.getByRole("button", { name: "Re-evaluate saved output", exact: true })).toBeDisabled();
  await panel.getByLabel("Selected evaluation").selectOption("evaluation-2");
  fixture.releaseEvaluation();
  await expect.poll(() => fixture.releasedResponse()).toBe(true);
  await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByRole("button", { name: "Re-evaluate saved output", exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(2);
  expect(fixture.generationPosts()).toBe(0);
});

for (const rejection of [{ status: 422, code: "evaluation_too_large" }, { status: 409, code: "route_unavailable" }]) {
  test(`corrects ${rejection.code} rejection and explicitly retries without an uncertain lock`, async ({ page }) => {
    // Arrange: the API rejects the first request before creating an evaluation.
    const fixture = await arrange(page, { firstQueueFailure: rejection });
    const panel = page.getByRole("region", { name: "Evaluation", exact: true });
    const evaluate = panel.getByRole("button", { name: "Evaluate saved output", exact: true });
    await panel.getByLabel(new RegExp("Use evaluation-reference.json")).check();
    await panel.getByText("Per-section evaluator settings", { exact: true }).click();
    const method = panel.getByRole("group", { name: "Gap extraction evaluator", exact: true }).getByLabel("Method");
    await method.selectOption("rubric_and_reference");
    await evaluate.click();
    await expect(panel.getByRole("alert")).toContainText("The evaluation request was rejected");
    // Act: correct the request without refreshing or discarding the editor.
    await panel.getByLabel(new RegExp("Use evaluation-reference.json")).uncheck();
    await method.selectOption("checks_only");
    // Assert: a confirmed rejection permits a fresh explicit request, never an automatic retry.
    await expect(evaluate).toBeEnabled();
    await expect(panel.getByText(/The queue request for this output has an uncertain outcome/)).toHaveCount(0);
    await expect(panel.getByLabel("Selected evaluation")).toHaveCount(0);
    expect(fixture.posts).toHaveLength(1);
    await evaluate.click();
    await expect(panel.getByText("Evaluation status: succeeded", { exact: true })).toBeVisible({ timeout: 10000 });
    expect(fixture.posts).toHaveLength(2);
    expect(fixture.posts[1]).toMatchObject({ reference_ids: [], config: { sections: { gap_extraction: { method: "checks_only" } } } });
    expect(fixture.generationPosts()).toBe(0);
  });
}

for (const failure of [{ status: 503, code: "development_unavailable" }, { status: 409, code: "dispatch_conflict" }, { status: 503, code: "route_unavailable" }]) {
  test(`preserves uncertainty for unconfirmed queue error ${failure.status}/${failure.code}`, async ({ page }) => {
    // Arrange: this response does not prove rejection before reservation, even with a familiar code.
    const fixture = await arrange(page, { firstQueueFailure: failure });
    const panel = page.getByRole("region", { name: "Evaluation", exact: true });
    await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
    // Act: reload returns no matching record; absence is not confirmation of a cancelled write.
    await expect(panel.getByText(/The queue request for this output has an uncertain outcome/)).toBeVisible();
    await panel.getByRole("button", { name: "Reload evaluation data" }).click();
    await expect(panel.getByText(/Evaluation data reloaded/)).toBeVisible();
    // Assert: unknown codes and mismatched code/status pairs never unlock or resend automatically.
    await expect(panel.getByRole("button", { name: "Evaluate saved output", exact: true })).toBeDisabled();
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.generationPosts()).toBe(0);
  });
}

test("refreshes execution history when an evaluation is queued and settled", async ({ page }) => {
  const fixture = await arrange(page);
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  const execution = page.getByRole("region", { name: "Execution", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await expect(execution.getByText(/Evaluation: queued · unavailable/)).toBeVisible();
  await expect(execution.getByText(/Evaluation: succeeded · unavailable/)).toBeVisible({ timeout: 10000 });
  await expect(execution.getByText(/Evaluation: succeeded · unavailable/)).toContainText("evaluation-1");
  await expect(panel.getByText(/Comparison with the selected saved output.*current/)).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
});


test("ignores a delayed queued execution history after the evaluation succeeds", async ({ page }) => {
  const fixture = await arrange(page, { holdQueuedHistory: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  const execution = page.getByRole("region", { name: "Execution", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await fixture.queuedHistoryStarted;
  await expect(execution.getByText(/Evaluation: succeeded · unavailable/)).toBeVisible({ timeout: 10000 });
  const oldResponse = page.waitForResponse(response => response.url().includes(`/development/${fixture.draft.id}/executions?`) && response.request().method() === "GET");
  fixture.releaseQueuedHistory();
  await oldResponse;
  await expect(execution.getByText(/Evaluation: succeeded · unavailable/)).toBeVisible();
  await expect(execution.getByText(/Evaluation: queued · unavailable/)).toHaveCount(0);
  await expect(execution.getByText(/Evaluation: succeeded · unavailable/)).toBeVisible();
  await expect(panel.getByLabel("Selected evaluation").locator('option[value="evaluation-1"]')).toContainText("succeeded");
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.generationPosts()).toBe(0);
});


test("keeps both pages fresh when loading older history during a succeeded refresh", async ({ page }) => {
  const fixture = await arrange(page, { paginated: true, holdSucceededHistory: true });
  const panel = page.getByRole("region", { name: "Evaluation", exact: true });
  const execution = page.getByRole("region", { name: "Execution", exact: true });
  await panel.getByRole("button", { name: "Evaluate saved output", exact: true }).click();
  await fixture.succeededHistoryStarted;
  await expect(execution.getByText("Evaluation: unavailable", { exact: true })).toBeVisible();
  await execution.getByRole("button", { name: "Load older executions" }).click();
  await expect(execution.getByLabel("Selected execution").locator('option[value="older-run"]')).toHaveCount(1);
  const oldResponse = page.waitForResponse(response => response.url().includes(`/development/${fixture.draft.id}/executions?`) && !response.url().includes("cursor=") && response.request().method() === "GET");
  fixture.releaseSucceededHistory();
  await oldResponse;
  await expect(execution.getByText("Generation freshness: current")).toBeVisible();
  await expect(execution.getByText(/Evaluation: succeeded · unavailable/)).toBeVisible();
  await expect(panel.getByLabel("Selected evaluation").locator('option[value="evaluation-1"]')).toContainText("succeeded");
  await expect(execution.getByRole("button", { name: "Load older executions" })).toHaveCount(0);
  await execution.getByLabel("Selected execution").selectOption("older-run");
  await expect(execution.getByText("Generation freshness: current")).toBeVisible();
  await expect(execution.getByText("Evaluation: unscored / not requested")).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.generationPosts()).toBe(0);
});

// Arrange a completed generation, act through a queued evaluator poll, assert shared spending updates.
test('queued evaluator spending pause refreshes the shared account without a status change', async ({ page }) => {
  const fixture = await arrange(page, { queuedSpendingPause: true, twoExecutions: true });
  const costs = page.getByRole('region', { name: 'Execution spending', exact: true });
  await expect(costs.getByText('Spending authorized', { exact: true })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Evaluation', exact: true });
  await panel.getByRole('button', { name: 'Evaluate saved output', exact: true }).click();
  await expect(panel.getByText('Evaluation status: queued', { exact: true })).toBeVisible();
  await expect(costs.getByText('Spending paused: Evaluator allowance exhausted.', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(costs.getByText('Evaluation known usage: USD 0.03', { exact: true })).toBeVisible();
  await expect(panel.getByText('Evaluation status: queued', { exact: true })).toBeVisible();
  await expect(costs.getByRole('button', { name: 'Resume spending', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Execution', exact: true }).getByLabel('Selected execution').selectOption('other-run');
  await expect(costs.getByText('Spending authorized', { exact: true })).toBeVisible();
  const previousPolls = fixture.polls();
  await page.waitForResponse(async response => {
    if (!new URL(response.url()).pathname.endsWith(`/api/admin/development/${fixture.draft.id}/executions`) || response.request().method() !== 'GET') return false;
    const body = await response.json();
    return body.executions[0].cost.evaluation_usage_usd > previousPolls * 0.03;
  }, { timeout: 10000 });
  // Let React paint the account refresh while the other execution remains selected.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('region', { name: 'Execution', exact: true }).getByLabel('Selected execution')).toHaveValue('other-run');
  await expect(costs.getByText('Spending authorized', { exact: true })).toBeVisible();
  await expect(costs.getByText('Evaluation known usage: USD 0', { exact: true })).toBeVisible();
});
