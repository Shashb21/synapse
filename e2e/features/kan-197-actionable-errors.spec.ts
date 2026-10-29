/** Browser acceptance for safe, actionable errors and truthful mutation recovery (KAN-197). */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import postgres from "postgres";
import { E2E_USER, freshWorkspace } from "../support/session";
import { requireDisposableDatabase } from "../support/disposable-database";
import { iegpAction, modulesState, planAction, planState, runStage } from "../support/synapse";

const RAW = "SQL SELECT secret FROM customer_accounts; sk-kan197-secret PROVIDER_RESPONSE {stack: private-workspace}";
const VIEWS = [
  { name: "desktop", width: 1280, height: 900, zoom: 1 },
  { name: "390px", width: 390, height: 844, zoom: 1 },
  { name: "200-percent-layout-zoom", width: 1280, height: 900, zoom: 2 },
] as const;

test.describe.configure({ mode: "serial", timeout: 90_000 });

/** Apply real layout magnification; CSS zoom is explicit rather than device pixel scaling. */
async function setView(page: Page, view: typeof VIEWS[number]) {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, view.zoom);
}

/** Assert the announced message stays readable and fully visible without an expansion. */
async function expectReadableAlert(page: Page, alert: Locator) {
  await expect(alert).toBeVisible();
  expect(await alert.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
  await alert.scrollIntoViewIfNeeded();
  await expect(alert).toBeInViewport();
  expect(await alert.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(page.locator("body")).not.toContainText(RAW);
  await expect(page.locator("body")).not.toContainText("sk-kan197-secret");
}

/** Keep screenshots outside tracked test outputs while attaching them to the report. */
async function capture(page: Page, info: TestInfo, label: string) {
  const path = `/private/tmp/kan197-browser-${info.testId.replace(/[^a-zA-Z0-9]/g, "-")}-${label}.png`;
  await page.screenshot({ path, fullPage: true });
  await info.attach(label, { path, contentType: "image/png" });
}

test.describe("owner control panel", () => {
  for (const view of VIEWS) {
    test(`${view.name}: raw failures are hidden, owner recovery works and validation stays specific`, async ({ page }, info) => {
      await page.goto("/admin/control");
      await page.waitForLoadState("networkidle");
      await setView(page, view);
      const stage = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "S2 · Evidence gap extraction", exact: true }) });
      await expect(stage).toContainText("Add a provider credential and select a compatible model here.");
      const provider = stage.getByRole("combobox", { name: "Provider", exact: true });
      await provider.selectOption("openai");
      let posts = 0;
      await page.route("**/api/control", async route => {
        if (route.request().method() !== "POST") return route.continue();
        posts += 1;
        await route.fulfill({ status: 500, json: { error: RAW } });
      });
      const save = stage.getByRole("button", { name: "Save route", exact: true });
      await save.focus();
      await page.keyboard.press("Enter");
      const alert = stage.getByRole("alert");
      await expect(alert).toContainText("Check the current state before trying again");
      await expect(alert).toContainText("contact your Synapse administrator");
      await expectReadableAlert(page, alert);
      await expect(provider).toHaveValue("openai");
      await expect(save).toBeEnabled();
      expect(posts).toBe(1);
      await capture(page, info, `${view.name}-owner-error`);
      await page.unroute("**/api/control");
      // The named owner recovery is a real configuration read, with no route write.
      const refresh = page.getByRole("button", { name: "Refresh configuration", exact: true });
      await refresh.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "Configuration refreshed. Saved settings are available." })).toBeVisible();
      await expect(provider).toHaveValue("openai");
      await stage.getByText("Advanced routing settings", { exact: true }).click();
      await stage.getByLabel("Temperature (0 to 2)").fill("3");
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(alert).toHaveText("Temperature must be a number from 0 to 2.");
      await expectReadableAlert(page, alert);
      await expect(stage.getByLabel("Temperature (0 to 2)")).toHaveValue("3");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  }
});

test.describe("customer workspace creation after an unconfirmed persisted write", () => {
  freshWorkspace({ name: "KAN197 create" });
  const created: { id: string; name: string }[] = [];

  test.afterAll(async () => {
    const pg = postgres(requireDisposableDatabase(process.env.E2E_DATABASE_URL), { max: 1, onnotice: () => {} });
    try {
      for (const owned of created) {
        if (!/^w[0-9a-f]{12}$/.test(owned.id)) throw new Error("Unexpected auxiliary fixture workspace id.");
        await pg.begin(async transaction => {
          const [row] = await transaction`SELECT name, created_by, schema_name FROM public.workspaces WHERE id = ${owned.id} FOR UPDATE`;
          if (!row || row.name !== owned.name || row.created_by !== E2E_USER.email || row.schema_name !== `ws_${owned.id}`) throw new Error("Auxiliary fixture ownership changed.");
          await transaction`DELETE FROM public.workspace_members WHERE workspace_id = ${owned.id}`;
          await transaction`DELETE FROM public.workspaces WHERE id = ${owned.id}`;
          await transaction`DROP SCHEMA ${transaction(row.schema_name)} CASCADE`;
        });
      }
    } finally { await pg.end(); }
  });

  for (const view of VIEWS) {
    test(`${view.name}: retain draft, block Cancel/repeat, and check the actual saved workspace list`, async ({ page, context, baseURL }, info) => {
      await context.addCookies([{ name: "synapse_test_as", value: "customer", url: baseURL! }]);
      await page.goto("/workspaces?new=1");
      await page.waitForLoadState("networkidle");
      await setView(page, view);
      const form = page.getByRole("form", { name: "Create a workspace" });
      const name = `KAN197 uncertain ${view.name} ${Date.now()}`;
      await form.getByLabel("Workspace name").fill(name);
      let posts = 0;
      await page.route("**/api/workspaces", async route => {
        if (route.request().method() !== "POST") return route.continue();
        posts += 1;
        // Persist the real operation, then replace its response with an untrusted failure.
        const response = await route.fetch();
        expect(response.ok(), await response.text()).toBe(true);
        const body = await response.json() as { workspace: { id: string; name: string } };
        created.push(body.workspace);
        await route.fulfill({ status: 500, json: { error: RAW } });
      });
      const submit = form.getByRole("button", { name: "Create workspace", exact: true });
      await submit.focus();
      await page.keyboard.press("Enter");
      const alert = form.getByRole("alert");
      await expect(alert).toContainText("Check the current state before trying again");
      await expectReadableAlert(page, alert);
      await expect(form.getByLabel("Workspace name")).toHaveValue(name);
      await expect(submit).toBeDisabled();
      await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "New workspace", exact: true })).toHaveCount(0);
      await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
      // Submitting via the DOM also exercises the handler guard, beyond disabled buttons.
      await form.evaluate(node => (node as HTMLFormElement).requestSubmit());
      expect(posts).toBe(1);
      await capture(page, info, `${view.name}-customer-unknown`);
      const check = form.getByRole("button", { name: "Check workspace list", exact: true });
      await check.focus();
      await expect(check).toBeFocused();
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("workspace-row").filter({ hasText: name })).toHaveCount(1);
      await expect(form.getByRole("alert")).toHaveCount(0);
      expect(posts).toBe(1);
      const listing = await page.request.get("/api/workspaces");
      const body = await listing.json() as { workspaces: { name: string }[] };
      expect(body.workspaces.filter(row => row.name === name)).toHaveLength(1);
    });
  }
});

test.describe("actual timeline partial save", () => {
  freshWorkspace({ name: "KAN197 timeline", seed: async request => {
    const gap = await iegpAction(request, { action: "create_gap", name: "Missing persistence evidence", statement: "Long-term persistence evidence is missing.", domain: "unmet_need" });
    await planAction(request, { action: "create_activity", gap_id: gap.id, name: "Persistence study", type: "rwe_study", evidence_question: "What is long-term persistence?", start_date: "2026-10-01", end_date: "2026-12-01", rationale: "Seed browser partial-save acceptance" });
  } });

  test("confirmed schedule freezes while rejected details are corrected without replaying the move", async ({ page, context, baseURL }, info) => {
    await context.addCookies([{ name: "synapse_test_as", value: "customer", url: baseURL! }]);
    const before = await planState(page.request);
    const activity = before.timeline.activities[0]!;
    await page.goto("/timeline");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Show not prioritized gaps", exact: true }).click();
    await page.locator('g[aria-label*="Persistence study"]').first().click();
    const panel = page.getByRole("dialog");
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const form = panel.getByTestId("activity-editor");
    const actions: string[] = [];
    let reject = true;
    await page.route(/\/api\/(plan|iegp)$/, async route => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON() as { action: string };
      actions.push(body.action);
      if (body.action === "modify_tactic" && reject) {
        reject = false;
        return route.fulfill({ status: 400, json: { safe_error: true, request_outcome: "rejected", error: "Choose a shorter budget description before saving the activity details." } });
      }
      return route.continue();
    });
    await form.getByLabel("End", { exact: true }).fill("2026-12-15");
    await form.getByLabel("Budget", { exact: true }).fill("Draft budget to correct");
    await form.getByLabel("Rationale for the change").fill("Finance confirmed this schedule");
    const save = form.getByRole("button", { name: "Save changes", exact: true });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(form.getByRole("alert")).toContainText("Schedule saved, but activity details could not be confirmed.");
    await expectReadableAlert(page, form.getByRole("alert"));
    await expect(form.getByRole("status")).toContainText("The schedule is saved. These fields are fixed");
    for (const name of ["start_date", "end_date", "readout_date", "lane", "schedule_rationale"]) await expect(form.locator(`[name="${name}"]`)).toBeDisabled();
    await expect(form.getByLabel("End", { exact: true })).toHaveValue("2026-12-15");
    await expect(form.getByLabel("Budget", { exact: true })).toHaveValue("Draft budget to correct");
    expect(actions).toEqual(["move_activity", "modify_tactic"]);
    const partial = await planState(page.request);
    expect(partial.timeline.activities.find(row => row.id === activity.id)?.end_date).toBe("2026-12-15");
    await capture(page, info, "timeline-schedule-saved-details-rejected");
    await form.getByLabel("Budget", { exact: true }).fill("$120k");
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(form).toBeHidden({ timeout: 20_000 });
    await expect(panel.getByText("$120k", { exact: true })).toBeVisible();
    expect(actions).toEqual(["move_activity", "modify_tactic", "modify_tactic"]);
    await page.reload();
    await page.getByRole("button", { name: "Show not prioritized gaps", exact: true }).click();
    await page.locator('g[aria-label*="Persistence study"]').first().click();
    await expect(page.getByRole("dialog").getByText("$120k", { exact: true })).toBeVisible();
    const after = await planState(page.request);
    expect(after.timeline.activities.find(row => row.id === activity.id)?.end_date).toBe("2026-12-15");
  });
});


test.describe("source ingestion with completed work", () => {
  const workspace = freshWorkspace({ name: "KAN197 ingestion" });

  test("keep the parsed source and draft after a raw extraction error, then resume without uploading twice", async ({ page, context, baseURL }, info) => {
    await context.addCookies([{ name: "synapse_test_as", value: "customer", url: baseURL! }]);
    await page.goto("/?place=upload");
    await page.waitForLoadState("networkidle");
    const form = page.getByRole("form", { name: "Add a source" });
    const title = "KAN197 persistence interview";
    const text = "Payers need long-term persistence evidence in routine care. Current evidence lacks 12-month persistence outcomes.";
    await form.getByLabel("Title", { exact: true }).fill(title);
    await form.getByRole("textbox", { name: "Source text", exact: true }).fill(text);
    const jobs: string[] = [];
    let calls = 0;
    await page.route("**/api/iegp", async route => {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action !== "ingest") return route.continue();
      calls += 1;
      // Upload and parsing really finish; the next extraction reply is untrusted.
      if (calls === 3) return route.fulfill({ status: 500, json: { error: RAW } });
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      const reply = await response.json() as { job_id: string };
      jobs.push(reply.job_id);
      return route.fulfill({ response });
    });
    const submit = form.getByRole("button", { name: "Add and read source", exact: true });
    await submit.focus();
    await page.keyboard.press("Enter");
    const alert = form.getByRole("alert");
    await expect(alert).toContainText("Retry to continue from the last completed step; earlier steps remain available.");
    await expectReadableAlert(page, alert);
    await expect(form.getByLabel("Title", { exact: true })).toHaveValue(title);
    await expect(form.getByRole("textbox", { name: "Source text", exact: true })).toHaveValue(text);
    await expect(submit).toBeEnabled();
    expect(calls).toBe(3);
    const pg = postgres(requireDisposableDatabase(process.env.E2E_DATABASE_URL), { max: 1 });
    try {
      const schema = `ws_${workspace.id}`;
      const saved = await pg`SELECT id, status, source_id FROM ${pg(schema)}.source_files WHERE title = ${title}`;
      expect(saved).toHaveLength(1);
      expect(saved[0].source_id).toBeTruthy();
      await capture(page, info, "source-partial-extraction-error");
      await submit.focus();
      await page.keyboard.press("Enter");
      await expect(form.getByRole("status")).toContainText(`Processed “${title}”`, { timeout: 60_000 });
      const resumed = await pg`SELECT id FROM ${pg(schema)}.source_files WHERE title = ${title}`;
      expect(resumed.map(row => row.id)).toEqual(saved.map(row => row.id));
      expect(new Set(jobs).size).toBe(1);
      await page.goto("/sources");
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
      await expect(page.locator("body")).not.toContainText(RAW);
    } finally { await pg.end(); }
  });
});

test.describe("historical owner failure", () => {
  const workspace = freshWorkspace({ name: "KAN197 history" });

  test("stored SQL/provider failures stay out of owner run APIs and the expanded trace", async ({ page, request }, info) => {
    const run = await runStage(request, "S0", { demo_ids: ["heor-interview"] });
    const pg = postgres(requireDisposableDatabase(process.env.E2E_DATABASE_URL), { max: 1 });
    try {
      const failureStep = [{ name: "historical:failure", at: new Date().toISOString(), duration_ms: 1, detail: RAW, data: { error: RAW, provider_response: { exception: RAW } } }];
      const updated = await pg`UPDATE ${pg(`ws_${workspace.id}`)}.module_runs SET status = 'error', error = ${RAW}, summary = ${RAW}, steps = steps || ${pg.json(failureStep)} WHERE id = ${run.run_id} RETURNING id`;
      expect(updated).toHaveLength(1);
    } finally { await pg.end(); }
    const response = await request.get(`/api/runs/${run.run_id}`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.run).toMatchObject({ id: run.run_id, stage: "S0", status: "error" });
    expect(body.run.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "historical:failure" })]));
    const state = await modulesState(request);
    expect(state.runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.run_id, stage: "S0", status: "error" })]));
    for (const payload of [body, state.runs]) {
      expect(JSON.stringify(payload)).not.toContain(RAW);
      expect(JSON.stringify(payload)).not.toContain("sk-kan197-secret");
    }
    await page.goto(`/admin/runs/${run.run_id}?workspace=${workspace.id}`);
    const failure = page.getByText("This run could not finish. Review the workspace and AI settings before running this task again.", { exact: true });
    await expectReadableAlert(page, failure);
    await expect(failure).toHaveAttribute("role", "alert");
    // Even expanding every available diagnostic does not reveal the historical exception.
    for (const detail of await page.locator("details").all()) await detail.evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await expect(page.locator("body")).not.toContainText(RAW);
    await expect(page.locator("body")).not.toContainText("sk-kan197-secret");
    await expect(page.locator("body")).toContainText("S0");
    await capture(page, info, "historical-owner-error-redacted");
  });
});
