/** Owner execution controls use scripted responses; no provider calls are made. */
import { expect, test } from "@playwright/test";

test("owner configures and starts a frozen execution", async ({ page }) => {
  // Arrange: the draft uses the isolated server; execution responses are scripted.
  const name = `Execution ${Date.now()}`;
  let posted: Record<string, unknown> | undefined;
  await page.route("**/api/admin/development/*/executions*", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      await route.fulfill({ status: 409, json: { error: "Prerequisites changed. Reload history." } });
    } else await route.fulfill({ json: { executions: [], delivery: { available: true, transport: "scripted", reason: null } } });
  });
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment" }).click();
  await page.getByLabel("Private source file").setInputFiles({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("Need comparative evidence.") });
  await page.getByRole("button", { name: "Upload source", exact: true }).click();
  await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
  await page.getByText("Gap extraction route and roles").click();
  // Act: select the experimental mode and request a fresh run.
  await page.getByLabel("Execution mode").selectOption("single_pass");
  await expect(page.getByLabel("Critic override", { exact: true }).first()).toBeDisabled();
  await page.getByRole("button", { name: "Run all sections" }).click();
  // Assert: a safe conflict is shown and no implicit retry occurs.
  await expect(page.getByRole("region", { name: "Execution", exact: true }).getByRole("alert")).toContainText("Prerequisites changed");
  expect(posted?.target).toBe("all");
  expect((posted?.config as { mode: string }).mode).toBe("single_pass");
});


test("history shows frozen routes, unreviewed outputs and stale prerequisites", async ({ page }) => {
  // Arrange: exercise the real draft API and script execution responses without a provider.
  const name = `History ${Date.now()}`;
  const ids = ["gap_extraction", "tactic_extraction", "matching_coverage", "partial_splitting"];
  let saved: Record<string, unknown> | null = null;
  let posts = 0;
  const rerunPayloads: Record<string, unknown>[] = [];
  await page.route("**/api/admin/development/*/executions*", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      const body = route.request().postDataJSON();
      if (posts > 1) { rerunPayloads.push(body); await route.fulfill({ status: 409, json: { error: "The prerequisite changed. Run it again." } }); return; }
      const routeConfig = body.config.stages.gap_extraction.route;
      saved = { id: "run-1", experiment_id: "fixture", created_at: "2026-10-30", updated_at: "2026-10-30", generation_status: "succeeded", evaluation_status: "not_requested", error: null, manifest: { revision: body.revision, config: body.config, routes: Object.fromEntries(ids.map((id) => [id, { proposer: { requested: routeConfig, actual: { provider_id: routeConfig.provider_id, model: routeConfig.model, reason: null } } }])) }, sections: ids.map((id, index) => ({ id: `attempt-${index}`, section: id, status: index === 3 ? "not_applicable" : "succeeded", result: { output_id: String(index).repeat(64), output: { accepted: [], rejected: [] }, candidates: [{ statement: `output ${index}` }], reason: index === 3 ? "No eligible partial gaps" : null }, error: null, prerequisites: index === 2 ? { gap_extraction: "attempt-0", tactic_extraction: "attempt-1" } : {} })), calls: [] };
      await route.fulfill({ status: 202, json: { execution: saved } });
    } else await route.fulfill({ json: { executions: saved ? [saved] : [], delivery: { available: true, reason: null } } });
  });
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment" }).click();
  await page.getByLabel("Private source file").setInputFiles({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("Need comparative evidence.") });
  await page.getByRole("button", { name: "Upload source", exact: true }).click();
  await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
  // Act: run all, inspect history and explicitly rerun a dependent section.
  await page.getByRole("button", { name: "Run all sections" }).focus();
  await page.keyboard.press("Enter");
  const execution = page.getByRole("region", { name: "Execution", exact: true });
  await expect(execution.getByText("Generation: succeeded · 4/4 sections finished")).toBeVisible();
  await expect(execution.getByText("Partial splitting: not_applicable")).toBeVisible();
  await expect(execution.getByText(/Generated output: unreviewed/).first()).toBeVisible();
  await expect(execution.getByText(/proposer: requested/).first()).toBeVisible();
  await execution.getByRole("button", { name: "Rerun Matching and coverage" }).click();
  await expect(execution.getByRole("alert")).toContainText("prerequisite changed");
  expect(posts).toBe(2);
  expect(rerunPayloads[0]?.prerequisites).toEqual({ gap_extraction: { attempt_id: "attempt-0", output_id: "0".repeat(64) }, tactic_extraction: { attempt_id: "attempt-1", output_id: "1".repeat(64) } });
  await page.reload();
  await page.getByRole("button", { name: `Open ${name}` }).click();
  await expect(execution.getByText("Partial splitting: not_applicable")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: ".superpowers/sdd/2026-10-30-kan-202/task-3-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".superpowers/sdd/2026-10-30-kan-202/task-3-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("polls only the selected active execution and shows terminal errors", async ({ page }) => {
  // Arrange: two saved histories and a scripted progress transition.
  const name = `Progress ${Date.now()}`;
  let lists = 0;
  let details = 0;
  const route = { provider_id: "xai-grok", model: "grok-4", temperature: 0.2, max_tokens: 16000, fallbacks: [] };
  const base = { experiment_id: "fixture", created_at: "2026-10-30", updated_at: "2026-10-30", evaluation_status: "not_requested", error: null, manifest: { revision: 1, config: { mode: "standard", evaluator: route }, routes: {} }, calls: [] };
  const running = { ...base, id: "active", generation_status: "running", sections: [{ id: "a", section: "gap_extraction", status: "running", result: null, error: null, prerequisites: {} }] };
  const finished = { ...running, generation_status: "needs_attention", error: "Inspect the uncertain request before retrying.", sections: [{ ...running.sections[0], status: "blocked", error: "Prerequisite failed." }] };
  await page.route("**/api/admin/development/*/executions*", async (request) => { lists++; await request.fulfill({ json: { executions: [running], delivery: { available: true, reason: null } } }); });
  await page.route("**/api/admin/development/*/executions/active*", async (request) => { details++; await request.fulfill({ json: { execution: finished } }); });
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment" }).click();
  const execution = page.getByRole("region", { name: "Execution", exact: true });
  // Act and assert: polling reads detail, then stops after the terminal state.
  await expect(execution.getByRole("button", { name: "Run all sections" })).toBeDisabled();
  await expect(execution.getByText(/Generation: needs_attention/)).toBeVisible({ timeout: 10000 });
  await expect(execution.getByText("Gap extraction: blocked")).toBeVisible();
  await expect(execution.getByText("Inspect the uncertain request before retrying.")).toBeVisible();
  expect(details).toBe(1);
  const settledLists = lists;
  await page.waitForTimeout(3500);
  expect(lists).toBe(settledLists);
  expect(details).toBe(1);
});

test("conflict discovers and polls an execution started elsewhere", async ({ page }, testInfo) => {
  // Arrange: this tab initially sees no history; a concurrent execution appears after a conflict.
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`console ${message.type()}: ${message.text()}\nlocation: ${JSON.stringify(message.location())}`);
  });
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.stack ?? error.message}`));
  const name = `Conflict ${Date.now()}`;
  let listReads = 0;
  let detailReads = 0;
  let posted = false;
  const route = { provider_id: "xai-grok", model: "grok-4", temperature: 0.2, max_tokens: 16000, fallbacks: [] };
  const running = { id: "external", experiment_id: "fixture", created_at: "2026-10-30", updated_at: "2026-10-30", generation_status: "running", evaluation_status: "not_requested", error: null, manifest: { revision: 1, config: { mode: "standard", evaluator: route }, routes: {} }, sections: [{ id: "attempt", section: "gap_extraction", status: "running", result: null, error: null, prerequisites: {} }], calls: [] };
  const finished = { ...running, generation_status: "failed", error: "Provider unavailable.", sections: [{ ...running.sections[0], status: "failed", error: "Provider unavailable." }] };
  await page.route("**/api/admin/development/*/executions*", async (request) => {
    if (request.request().method() === "POST") { posted = true; await request.fulfill({ status: 409, json: { error: "An execution is already active." } }); }
    else { listReads++; await request.fulfill({ json: { executions: posted ? [running] : [], delivery: { available: true, reason: null } } }); }
  });
  await page.route("**/api/admin/development/*/executions/external*", async (request) => { detailReads++; await request.fulfill({ json: { execution: finished } }); });
  try {
    await page.goto("/admin/development");
    await page.getByLabel("New experiment name").fill(name);
    await page.getByRole("button", { name: "Create experiment" }).click();
    await page.getByLabel("Private source file").setInputFiles({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("Need comparative evidence.") });
    await page.getByRole("button", { name: "Upload source", exact: true }).click();
    await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
    const execution = page.getByRole("region", { name: "Execution", exact: true });
    await expect(execution.getByText("No executions yet.")).toBeVisible();
    // Act: a concurrent execution causes a conflict and authoritative refresh.
    await execution.getByRole("button", { name: "Run all sections" }).click();
    // Assert: it is selected and detail polling reaches its terminal state.
    await expect(execution.getByRole("alert")).toContainText("already active");
    await expect(execution.getByText(/Generation: failed/)).toBeVisible({ timeout: 10000 });
    expect(listReads).toBeGreaterThanOrEqual(2);
    expect(detailReads).toBeGreaterThanOrEqual(1);
  } finally {
    await testInfo.attach("browser-diagnostics", { body: diagnostics.length ? diagnostics.join("\n\n") : "No browser console errors/warnings or page errors captured.", contentType: "text/plain" });
    console.log(`BROWSER_DIAGNOSTICS ${diagnostics.length ? diagnostics.join("\n\n") : "none"}`);
  }
});

test("shows unreviewed extraction candidates in single pass history", async ({ page }) => {
  // Arrange: representative persisted results; provider responses are scripted offline.
  const name = `Candidates ${Date.now()}`;
  const route = { provider_id: "xai-grok", model: "grok-4", temperature: 0.2, max_tokens: 16000, fallbacks: [] };
  const base = { experiment_id: "fixture", created_at: "2026-10-30", updated_at: "2026-10-30", generation_status: "succeeded", evaluation_status: "not_requested", error: null, calls: [] };
  const sections = [
    { id: "gap", section: "gap_extraction", status: "succeeded", error: null, prerequisites: {}, result: { reason: null, output: { mode: "llm", proposed: 1, accepted: [], rejected: [], committed_gap_ids: [], committed_need_ids: [], joined_gap_ids: [], suggestion_ids: [] }, candidates: [{ id: "g1", document_id: "doc", source_id: "source", name: "Comparative evidence", statement: "Comparative effectiveness remains unknown.", domain: "comparative_effectiveness", source_quote: "Comparative outcomes remain uncertain." }] } },
    { id: "tactic", section: "tactic_extraction", status: "succeeded", error: null, prerequisites: {}, result: { reason: null, output: { mode: "llm", proposed: 1, accepted: [], rejected: [], committed_tactic_ids: [], suggestion_ids: [] }, candidates: [{ id: "t1", document_id: "doc", source_id: "source", name: "Observational outcomes study", type: "rwe_study", status: "ongoing", evidence_question: "What are patient outcomes?", source_quote: "An outcomes study is ongoing." }] } },
    { id: "empty", section: "partial_splitting", status: "not_applicable", error: null, prerequisites: {}, result: { reason: "No eligible partial gaps", output: { stage_results: [] }, candidates: [] } },
  ];
  const single = { ...base, id: "single", manifest: { revision: 1, config: { mode: "single_pass", evaluator: route }, routes: {} }, sections };
  const standard = { ...base, id: "standard", manifest: { revision: 1, config: { mode: "standard", evaluator: route }, routes: {} }, sections: [{ ...sections[0], result: { ...sections[0].result, output: { accepted: [{ statement: "Standard accepted stage output" }] }, candidates: [{ statement: "Standard unreviewed candidate" }] } }] };
  await page.route("**/api/admin/development/*/executions*", async (request) => { await request.fulfill({ json: { executions: [single, standard], delivery: { available: true, reason: null } } }); });
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment" }).click();
  const execution = page.getByRole("region", { name: "Execution", exact: true });
  // Act and assert: definition fields expose proposals separately from retained raw output.
  await execution.getByText("View generated output").nth(0).click();
  await execution.getByText("View generated output").nth(1).click();
  await expect(execution.getByRole("definition").filter({ hasText: /^Comparative effectiveness remains unknown\.$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^Comparative outcomes remain uncertain\.$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^What are patient outcomes\?$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^An outcomes study is ongoing\.$/ })).toBeVisible();
  await expect(execution.getByText(/"accepted":\s*\[\]/).first()).toBeVisible();
  await execution.getByText("View generated output").nth(2).click();
  const emptySplittingOutput = execution.locator("pre").filter({ hasText: '"stage_results":[]' });
  await expect(emptySplittingOutput).toBeVisible();
  await expect(emptySplittingOutput).toContainText('"candidates":[]');
  await execution.getByLabel("Selected execution").selectOption("standard");
  const standardOutput = execution.locator("details").filter({ hasText: "View generated output" });
  if (await standardOutput.getAttribute("open") === null) {
    await standardOutput.getByText("View generated output").click();
  }
  await expect(execution.getByRole("definition").filter({ hasText: /^Standard unreviewed candidate$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^Standard accepted stage output$/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: `Open ${name}` }).click();
  await execution.getByText("View generated output").nth(0).click();
  await execution.getByText("View generated output").nth(1).click();
  await expect(execution.getByRole("definition").filter({ hasText: /^Comparative effectiveness remains unknown\.$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^What are patient outcomes\?$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^Comparative outcomes remain uncertain\.$/ })).toBeVisible();
  await expect(execution.getByRole("definition").filter({ hasText: /^An outcomes study is ongoing\.$/ })).toBeVisible();
});
