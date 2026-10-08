import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { workspaceUrl } from "../support/accuracy";
import { KAN83_URL, KAN83_PROVIDER_URL, KAN83_EMAIL, KAN83_PASSWORD, KAN83_SOURCE, startKan83Provider } from "../support/kan83-provider";

test.use({ actionTimeout: 20_000, baseURL: KAN83_URL, storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });
test.describe("KAN83 Accuracy stage completion (scripted HTTP provider, real owner session)", () => {
  let stop: (() => Promise<void>) | undefined;
  test.beforeAll(async () => { test.setTimeout(180_000); stop = await startKan83Provider(); });
  test.afterAll(async () => { test.setTimeout(45_000); await stop?.(); });
  test("fresh upload, complete paged coverage, human split and residual priority preserve guarded rollback", async ({ page, request }) => {
    test.setTimeout(360_000);
    const login = await request.post("/api/auth/password/login", { data: { email: KAN83_EMAIL, password: KAN83_PASSWORD } });
    expect(login.ok(), await login.text()).toBe(true);
    await page.context().addCookies((await request.storageState()).cookies);
    const created = await request.post("/api/accuracy/workspaces", { data: { name: "KAN83 browser proof", slug: `kan83-browser-${Date.now()}`, org_name: "KAN83 fixture" } });
    expect(created.ok(), await created.text()).toBe(true);
    const { workspace_id: workspaceId } = await created.json();
    await page.goto(workspaceUrl("/admin/accuracy/sources", workspaceId));
    await page.getByLabel("File", { exact: true }).setInputFiles({ name: "kan83-evidence.txt", mimeType: "text/plain", buffer: Buffer.from(KAN83_SOURCE) });
    await page.getByRole("button", { name: "Upload & parse" }).click();
    await expect(page.getByText(/Uploaded kan83-evidence.txt/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Extract needs + inventory" }).click();
    await expect(page.getByTestId("extract-outcome")).toContainText("Source extraction incomplete", { timeout: 60_000 });
    await page.reload();
    await expect(page.getByText(/Source progress:.*Full source: incomplete/)).toBeVisible();
    await page.getByText("Extraction page attempts and cursor").click();
    await expect(page.getByText(/Cursor: .*Scope: all/)).toBeVisible();
    await page.getByRole("button", { name: "Retry remaining pages" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("extract-outcome")).toContainText("Extracted 27 gap(s) · 4 tactic(s)", { timeout: 60_000 });

    await approveCurrentProposal(page, request, workspaceId);
    const claims = (await (await request.get(`/api/accuracy/claims?workspace_id=${workspaceId}`)).json()).claims.filter((row: { metadata: { history_only?: boolean } }) => !row.metadata.history_only);
    expect(claims.filter((row: { claim_type: string }) => row.claim_type === "gap")).toHaveLength(27);
    expect(claims.filter((row: { claim_type: string }) => row.claim_type === "tactic")).toHaveLength(4);
    const gap = claims.find((row: { metadata: { external_id?: string } }) => row.metadata.external_id === "GAP01");
    const clean = claims.find((row: { metadata: { external_id?: string } }) => row.metadata.external_id === "GAP02");
    const fourth = claims.find((row: { metadata: { external_id?: string } }) => row.metadata.external_id === "T4");
    const nonCommittedGap = claims.find((row: { metadata: { external_id?: string } }) => row.metadata.external_id === "GAP03");
    const nonCommittedTactics = claims.filter((row: { metadata: { external_id?: string } }) => ["T1", "T2", "T3"].includes(row.metadata.external_id ?? ""));
    await page.goto(workspaceUrl("/admin/accuracy/ledger", workspaceId));
    const card = page.getByTestId(`ledger-claim-${gap.id}`);
    await expect(card).toContainText("Indication: NSCLC");
    await expect(card).toContainText("Disease setting: Unknown (not_stated)");
    await card.getByRole("link", { name: /Source .*block/ }).first().click();
    await expect(page.getByTestId("parse-block-text").filter({ hasText: "GAP01" })).toBeVisible();
    await page.goto(workspaceUrl("/admin/accuracy/ledger", workspaceId));
    await expect(card).toContainText("Validation: current");

    await page.goto(workspaceUrl("/admin/accuracy/coverage", workspaceId));
    await expect(page.getByText(/108 eligible pair\(s\)/)).toBeVisible();
    await page.getByRole("button", { name: "Assess pending pairs on this page" }).click();
    await expect(page.getByText(/108 assessed/)).toBeVisible({ timeout: 120_000 });
    await page.getByRole("link", { name: "Next 100 pairs" }).click();
    await expect(page.getByRole("link", { name: "First page / restart" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Next 100 pairs" })).toHaveCount(0);
    await page.getByRole("button", { name: "Assess pending pairs on this page" }).click();
    await expect(page.getByText(/108 assessed/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: "Next 100 pairs" })).toHaveCount(0);
    await page.getByRole("link", { name: "First page / restart" }).click();
    await expect(page.getByRole("link", { name: "Next 100 pairs" })).toBeVisible();
    // The fourth inventory item is available in the exhaustive manual picker.
    await decidePair(page, request, workspaceId, gap.id, fourth.id, "Partial");
    await decidePair(page, request, workspaceId, clean.id, fourth.id, "Limited");
    await decidePair(page, request, workspaceId, nonCommittedGap.id, fourth.id, "Not relevant");
    for (const tactic of nonCommittedTactics) await decidePair(page, request, workspaceId, nonCommittedGap.id, tactic.id, "Full");
    await page.goto(workspaceUrl("/admin/accuracy/ledger", workspaceId));
    await expect(page.getByTestId(`ledger-claim-${gap.id}`)).toContainText("Computed: partial · Effective: partial");
    await expect(page.getByTestId(`ledger-claim-${clean.id}`)).toContainText("Computed: partial · Effective: partial");
    await expect(page.getByTestId(`ledger-claim-${nonCommittedGap.id}`)).toContainText("Computed: open · Effective: open");

    const first = await confirmSplit(page, request, workspaceId, gap.id);
    // Explicit workspace configuration, never Default inheritance/backfill.
    for (const pair of [{ scope: "all", x_axis: "decision_impact", y_axis: "time_pressure" }, { scope: "nsclc", x_axis: "effort_cost", y_axis: "payer_value" }]) {
      const state = await (await request.get(`/api/accuracy/claims/priority?workspace_id=${workspaceId}`)).json();
      const configured = await request.post("/api/accuracy/claims/priority", { data: { action: "configure", workspace_id: workspaceId, expected_config_revision: state.config.revision, ...pair, rationale: "Browser reviewer saves distinct setting pairs" } });
      expect(configured.ok(), await configured.text()).toBe(true);
    }
    await page.goto(workspaceUrl("/admin/accuracy/plan", workspaceId));
    await expect(page.getByTestId(`plan-gap-${gap.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`plan-gap-${clean.id}`)).toContainText("partial");
    const priorityCard = page.getByTestId(`plan-gap-${first.open_residual_gap_id}`);
    await priorityCard.getByRole("button", { name: "Review S8 priority" }).click();
    const priority = priorityCard.getByRole("region", { name: "S8 priority review" });
    await expect(priority).toContainText("Eligible Open gap");
    await expect(priority).toContainText("Human working decision: None · Validation: unvalidated");
    await priority.getByRole("button", { name: "Suggest S8 priority" }).click();
    await expect(priority).toContainText("Fresh suggestion: defer", { timeout: 30_000 });
    const storedDraft = (await (await request.get(`/api/accuracy/claims/priority?workspace_id=${workspaceId}`)).json()).placements.find((row: { gap_id: string }) => row.gap_id === first.open_residual_gap_id);
    expect(storedDraft.selection).toMatchObject({ setting: "all", x_axis: "decision_impact", y_axis: "time_pressure" });
    await priority.getByLabel("Setting", { exact: true }).fill("nsclc");
    await priority.getByRole("button", { name: "Reload current priority inputs" }).click();
    await expect(priority.getByLabel("Horizontal axis")).toHaveValue("effort_cost");
    await expect(priority.getByLabel("Vertical axis")).toHaveValue("payer_value");
    await expect(priority).toContainText("Saved axis pair");
    await expect(priority).toContainText("Effort & cost (lower is higher priority)");
    // This residual has no disease-setting fact: keep the real eligibility refusal.
    await expect(priority).toContainText("Priority unavailable: outside_setting");
    await priority.getByLabel("Setting", { exact: true }).fill("all");
    await priority.getByRole("button", { name: "Reload current priority inputs" }).click();
    await expect(priority.getByLabel("Horizontal axis")).toHaveValue("decision_impact");
    await expect(priority.getByLabel("Vertical axis")).toHaveValue("time_pressure");
    await expect(priority).toContainText("Saved axis pair");
    await priority.getByLabel("Horizontal axis").selectOption("effort_cost");
    await priority.getByLabel("Vertical axis").selectOption("decision_impact");
    await priority.getByRole("button", { name: "Reload current priority inputs" }).click();
    await expect(priority).toContainText("Custom axis pair — not saved for this setting");
    await priority.getByText("Save Accuracy axis pair and planning context", { exact: true }).click();
    await priority.getByLabel("Key decision").fill("Comparator question for the next evidence study");
    await priority.getByLabel("Configuration rationale").fill("Use saved effort direction and decision impact for this residual");
    await priority.getByRole("button", { name: "Save Accuracy configuration" }).click();
    await expect(priority).toContainText("Saved axis pair");
    await expect(priority).toContainText("Effort & cost (lower is higher priority)");
    await priority.getByRole("button", { name: "Suggest S8 priority" }).click();
    await expect(priority).toContainText("Fresh suggestion: defer", { timeout: 30_000 });
    await expect(priority).toContainText("Human working decision: None · Validation: unvalidated");
    await expect(priority).toContainText("Validation: unvalidated");
    const failedReadPattern = "**/api/accuracy/claims/priority?workspace_id=*&gap_id=*";
    await page.route(failedReadPattern, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture read unavailable" }) }));
    try {
      await priority.getByRole("button", { name: "Reload current priority inputs" }).click();
      await expect(priority.getByRole("alert")).toContainText("Fixture read unavailable");
      await expect(priority.getByText(/^Fresh suggestion:/)).toHaveCount(0);
    } finally { await page.unroute(failedReadPattern); }
    const r1 = await (await request.get(`/api/accuracy/claims/priority?workspace_id=${workspaceId}`)).json();
    const r2 = await request.post("/api/accuracy/claims/priority", { data: { action: "configure", workspace_id: workspaceId, expected_config_revision: r1.config.revision,
      context: { key_decision: "Browser reviewer changes the decision after a failed read" }, rationale: "Read changed planning inputs after connection recovery" } });
    expect(r2.ok(), await r2.text()).toBe(true);
    await priority.getByRole("button", { name: "Reload current priority inputs" }).click();
    await expect(priority.getByRole("button", { name: "Suggest S8 priority" })).toBeEnabled();
    await expect(priority.getByText(/^Fresh suggestion:/)).toHaveCount(0);
    await priority.getByRole("button", { name: "Suggest S8 priority" }).click();
    await expect(priority).toContainText("Fresh suggestion: defer", { timeout: 30_000 });
    await request.get(`${KAN83_PROVIDER_URL}/fail-priority`);
    await priority.getByRole("button", { name: "Suggest S8 priority" }).click();
    await expect(priority.getByRole("alert")).toContainText("Enter a working band and rationale manually", { timeout: 30_000 });
    await priority.getByLabel("Working priority").selectOption("defer");
    await priority.getByLabel("S8 rationale", { exact: true }).fill("Comparator needs a later study; preserve this human decision");
    await priority.getByRole("button", { name: "Validate working priority" }).focus(); await page.keyboard.press("Enter");
    await expect(priority).toContainText("Human working decision: defer · Validation: current", { timeout: 30_000 });
    await priority.getByText("Save Accuracy axis pair and planning context", { exact: true }).click();
    await priority.getByLabel("Key decision").fill("Comparator evidence for a revised decision date");
    await priority.getByLabel("Configuration rationale").fill("The planning decision changed; recheck the retained human priority");
    await priority.getByRole("button", { name: "Save Accuracy configuration" }).click();
    await expect(priority).toContainText("Human working decision: defer · Validation: stale");
    await priority.getByRole("button", { name: "Validate working priority" }).click();
    await expect(priority).toContainText("Human working decision: defer · Validation: current");
    const prior = (await (await request.get(`/api/accuracy/claims/priority?workspace_id=${workspaceId}`)).json()).placements.find((row: { gap_id: string }) => row.gap_id === first.open_residual_gap_id);
    await page.goto(workspaceUrl("/admin/accuracy/ledger", workspaceId));
    const blocked = page.getByTestId(`split-operation-${first.operation_id}`);
    await rollback(page, blocked);
    await expect(blocked.getByRole("alert")).toContainText("Later human decisions are preserved");
    const after = (await (await request.get(`/api/accuracy/claims/priority?workspace_id=${workspaceId}`)).json()).placements.find((row: { gap_id: string }) => row.gap_id === first.open_residual_gap_id);
    expect(after).toEqual(prior);
    // A separate clean split proves the successful inverse without deleting human decisions.
    const second = await confirmSplit(page, request, workspaceId, clean.id, " for the clean rollback group");
    const inverse = page.getByTestId(`split-operation-${second.operation_id}`);
    await rollback(page, inverse);
    await expect(inverse).toContainText("Inverse awaiting assembly approval");
    await approveCurrentProposal(page, request, workspaceId);
    await expect(inverse).toContainText("rolled_back", { timeout: 30_000 });
    await expect(page.getByTestId(`ledger-claim-${clean.id}`)).toContainText("Computed: partial");
    await expect(page.getByTestId(`ledger-claim-${second.open_residual_gap_id}`)).toHaveCount(0);
    await expect(blocked).toContainText("applied");
    const control = await (await request.get("/api/control")).json();
    try {
      const switched = await request.post("/api/control", { data: { action: "set_ai_enabled", enabled: false, rationale: "Browser proof of manual Accuracy controls" } });
      expect(switched.ok(), await switched.text()).toBe(true);
      await page.goto(workspaceUrl("/admin/accuracy/ledger", workspaceId));
      await page.getByTestId(`ledger-claim-${clean.id}`).getByRole("button", { name: "Resolve Partial gap" }).click();
      const manual = page.getByTestId(`ledger-claim-${clean.id}`).getByRole("region", { name: "Resolve Partial gap" });
      await expect(manual.getByRole("button", { name: "Suggest a split" })).toHaveCount(0);
      await expect(manual.getByRole("button", { name: "Prepare manual split" })).toBeEnabled();
      await manual.getByRole("button", { name: "Prepare manual split" }).focus(); await page.keyboard.press("Enter");
      await expect(manual.getByLabel("Addressed statement")).toBeVisible();
      await expect(manual.getByRole("button", { name: "Confirm and apply split" })).toBeDisabled();
      await manual.getByLabel("Addressed name", { exact: true }).fill("Manually reviewed outcomes");
      await manual.getByLabel("Addressed statement", { exact: true }).fill("Need the outcomes already covered by the chart review.");
      await manual.getByLabel("Residual name", { exact: true }).fill("Manually retained comparative uncertainty");
      await manual.getByLabel("Residual statement", { exact: true }).fill("Need the remaining comparative outcomes evidence.");
      for (const evidence of await manual.getByRole("checkbox", { name: /^Addressed evidence:/ }).all()) await evidence.check();
      await manual.getByRole("group", { name: "Committed closing tactics" }).getByRole("checkbox").first().check();
      await manual.getByRole("checkbox", { name: "comparator", exact: true }).check();
      await manual.getByLabel("Split rationale (required)", { exact: true }).fill("Manual source review with AI disabled; comparator evidence remains unknown");
      await manual.getByRole("checkbox", { name: "I reviewed both exact statements, closing tactics and evidence." }).check();
      const manualResponse = page.waitForResponse(response => response.url().endsWith("/api/accuracy/claims/split/apply"));
      await manual.getByRole("button", { name: "Confirm and apply split" }).click();
      const savedManual = await manualResponse;
      expect(savedManual.ok(), await savedManual.text()).toBe(true);
      const manualCandidate = await savedManual.json();
      expect(manualCandidate.state).toBe("awaiting_approval");
      await approveCurrentProposal(page, request, workspaceId, manualCandidate.assembly_id);
      await expect(page.getByTestId(`split-operation-${manualCandidate.operation_id}`)).toContainText("applied");
      await page.goto(workspaceUrl("/admin/accuracy/plan", workspaceId));
      await priorityCard.getByRole("button", { name: "Review S8 priority" }).click();
      await expect(priority.getByRole("button", { name: "Suggest S8 priority" })).toHaveCount(0);
      await priority.getByLabel("S8 rationale", { exact: true }).fill("Human rechecks this deferred residual with AI switched off");
      await priority.getByRole("button", { name: "Validate working priority" }).focus(); await page.keyboard.press("Enter");
      await expect(priority).toContainText("Human working decision: defer · Validation: current");
    } finally {
      const restored = await request.post("/api/control", { data: { action: "set_ai_enabled", enabled: control.ai.enabled, rationale: "Restore the pre-proof AI setting" } });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
  });
});
async function decidePair(page: Page, request: APIRequestContext, workspaceId: string, gapId: string, tacticId: string, overall: "Full" | "Partial" | "Limited" | "Not relevant") {
  await page.waitForLoadState("networkidle");
  const form = page.getByTestId("coverage-manual-pair");
  if (!await form.count()) await page.getByRole("button", { name: "Pick a pair" }).click();
  await expect(form).toBeVisible();
  await form.getByLabel("Gap", { exact: true }).selectOption(gapId);
  await form.getByLabel("Tactic", { exact: true }).selectOption(tacticId);
  await form.getByRole("button", { name: overall, exact: true }).click();
  for (const evidence of await form.getByRole("checkbox", { name: /^Evidence:/ }).all()) await evidence.check();
  await form.getByPlaceholder("Why this coverage decision (required)").fill("Human verified fourth tactic covers outcomes; comparator remains");
  await form.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByText("Saved successor awaiting assembly approval.", { exact: false })).toBeVisible();
  await approveCurrentProposal(page, request, workspaceId);
  await page.goto(workspaceUrl("/admin/accuracy/coverage", workspaceId));
}
async function confirmSplit(page: Page, request: APIRequestContext, workspaceId: string, gapId: string, suffix = "") {
  const card = page.getByTestId(`ledger-claim-${gapId}`);
  await card.getByRole("button", { name: "Resolve Partial gap" }).click();
  const form = card.getByRole("region", { name: "Resolve Partial gap" });
  await form.getByRole("button", { name: "Suggest a split" }).click();
  await expect(form.getByLabel("Addressed statement")).toHaveValue(`Need outcome evidence from the planned chart review${suffix}.`, { timeout: 30_000 });
  await expect(form.getByLabel("Residual statement")).toHaveValue(`Need comparative evidence against standard care${suffix}.`);
  await expect(form.getByRole("link", { name: /Source .*block/ }).first()).toBeVisible();
  await expect(form.getByRole("button", { name: "Confirm and apply split" })).toBeDisabled();
  await form.getByLabel("Split rationale (required)").fill("Confirm chart review outcome slice and separate comparator question");
  await form.getByRole("checkbox", { name: "I reviewed both exact statements, closing tactics and evidence." }).check();
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/accuracy/claims/split/apply"));
  await form.getByRole("button", { name: "Confirm and apply split" }).click();
  const response = await responsePromise; expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result.state).toBe("awaiting_approval");
  const pending = await (await request.get(`/api/accuracy/claims/split?workspace_id=${workspaceId}`)).json();
  expect(pending.operations.find((row: { id: string }) => row.id === result.operation_id).state).toBe("awaiting_approval");
  await approveCurrentProposal(page, request, workspaceId, result.assembly_id);
  await expect(card).toHaveCount(0);
  const history = await (await request.get(`/api/accuracy/claims/split?workspace_id=${workspaceId}`)).json();
  expect(history.operations.find((row: { id: string }) => row.id === result.operation_id).state).toBe("applied");
  return result;
}
async function rollback(page: Page, operation: ReturnType<Page["getByTestId"]>) {
  await page.waitForLoadState("networkidle");
  await operation.getByLabel("Rollback rationale (required)").fill("Restore the original question if safe; retain later decisions");
  await operation.getByRole("checkbox").check();
  const response = page.waitForResponse(result => result.url().endsWith("/api/accuracy/claims/split/rollback"));
  await operation.getByRole("button", { name: "Rollback split" }).click();
  await response;
}

/** Inspect exact evidence and changes using the delivered review UI before approving. */
async function approveCurrentProposal(page: Page, request: APIRequestContext, workspaceId: string, assemblyId?: string) {
  const response = await request.get(`/api/accuracy/assemblies?workspace_id=${workspaceId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const list = await response.json();
  const id = assemblyId ?? list.assemblies[0].id;
  await page.goto(workspaceUrl("/admin/accuracy/ledger", workspaceId));
  const proposals = page.getByRole("region", { name: "Complete assembly proposals", exact: true });
  await proposals.getByRole("button", { name: "Complete proposals", exact: true }).click();
  await proposals.getByRole("button", { name: `Inspect proposal ${id}`, exact: true }).click();
  await expect(proposals.getByRole("region", { name: "Selected items", exact: true })).toBeVisible();
  await expect(proposals.getByRole("region", { name: "Coverage outcomes", exact: true })).toBeVisible();
  const review = proposals.getByRole("form", { name: "Review proposal", exact: true });
  await review.getByLabel("Review rationale", { exact: true }).fill("Reviewed exact source quotes, changed selections and unresolved pending work; scripted fixture only");
  for (const checkbox of await review.getByRole("checkbox").all()) await checkbox.check();
  for (const reason of await review.getByLabel(/^Reason for advisory /).all()) await reason.fill("Reviewed limitation; pending evidence remains pending and contributes no closure");
  const approval = page.waitForResponse(response => response.url().includes("/api/accuracy/assemblies") && response.request().method() === "POST");
  await review.getByRole("button", { name: "Approve proposal", exact: true }).click();
  const result = await approval; expect(result.ok(), await result.text()).toBe(true);
  await page.reload();
}
