import { requireDisposableDatabase } from "../support/disposable-database";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { freshWorkspace } from "../support/session";
import { iegpAction, newestRunId, planAction, planState, runStage, waitForNewRun } from "../support/synapse";
import { execFileSync } from "node:child_process";

test.use({ actionTimeout: 10_000 });

let supported = "", legacy = "", confirmed = "";
const databaseUrl = requireDisposableDatabase(process.env.DATABASE_URL);
const workspace = freshWorkspace({ name: "KAN132 supported AI priority", seed: async request => {
  await iegpAction(request, { action: "save_product_setup", mark_complete: true, reason: "Record committee context", context: {
    asset_name: "Support fixture", therapeutic_area: "Immunology", indications: [{ name: "Psoriasis", status: "current" }], lifecycle_stage: "growth", markets: ["US"], plan_owner: "Evidence lead", sponsoring_function: "Medical Affairs", stakeholders: [{ function: "HEOR", lead: "Evidence lead" }], treatment_settings: ["1L"],
    objectives: [{ name: "Committee submission", key_decision: "Submit comparative evidence", decision_date: "2028-06-30" }],
  } });
  for (const name of ["Supported comparison", "Older unsupported suggestion", "Previously confirmed human priority"]) {
    const result = await iegpAction(request, { action: "create_gap", name, statement: `${name}: comparative evidence is missing.`, domain: "comparative_effectiveness", settings: "1L" });
    const id = String(result.id);
    if (!supported) supported = id; else if (!legacy) legacy = id; else confirmed = id;
    await iegpAction(request, { action: "validate_gap", gap_id: id });
  }
  await iegpAction(request, { action: "complete_wizard" });
  await planAction(request, { action: "save_scope_axes", scope: "all", x_axis: "decision_impact", y_axis: "time_pressure" });
} });


test("inspects supplied support, accepts atomically, offers manual legacy review and preserves human values on rerun", async ({ page, request }) => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, ["--import", "tsx", "e2e/support/supported-priority-fixture.ts", workspace.id, supported], { timeout: 60_000, env: { ...process.env, SYNAPSE_TEST_STUB_LLM: "" }, stdio: "pipe" });
  const pg = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await pg`select schema_name from workspaces where id=${workspace.id}`;
    const schema = row!.schema_name as string;
    await pg`insert into ${pg(schema)}.priority_placements (gap_id,axis_scores,suggested_band,suggested_rationale,band,validated,rationale,actor_name,at) values
      (${legacy},'{"decision_impact":70,"time_pressure":70}'::jsonb,'high','Earlier model suggestion','high',false,null,null,'2025-01-01T00:00:00Z'),
      (${confirmed},'{"decision_impact":82,"time_pressure":76}'::jsonb,'high','Earlier model suggestion','high',true,'Original human rationale','Earlier reviewer','2025-01-01T00:00:00Z')`;
  } finally { await pg.end({ timeout: 5 }); }
  await page.goto("/?place=plan&setting=all");
  await page.getByRole("button", { name: /^Supported comparison: High, priority not validated/ }).focus();
  await page.keyboard.press("Enter");
  const article = page.getByTestId("gap-panel");
  await page.route("**/api/plan/references?*", route => route.fulfill({ status: 500, body: "Reference load failed" }), { times: 1 });
  await article.getByRole("button", { name: "Inspect supporting references" }).click();
  await expect(article.getByRole("alert")).toContainText("could not be loaded");
  await page.route("**/api/plan/references?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "newer-suggestion-b", references: [{ entity_type: "gap", entity_id: supported, title: "Newer suggestion B support", excerpt: "Evidence for a different suggestion", reason: "Supports suggestion B", href: `/gaps/${supported}` }] }) }), { times: 1 });
  await article.getByRole("button", { name: "Inspect supporting references" }).click();
  await expect(article.getByRole("alert")).toContainText("This suggestion changed. Refresh the page and inspect the current suggestion");
  await expect(article.getByText("Newer suggestion B support", { exact: true })).toHaveCount(0);
  await article.getByRole("button", { name: "Inspect supporting references" }).focus();
  await page.keyboard.press("Enter");
  await expect(article.getByText("Supports: This supplied record explains the committee evidence need").first()).toBeVisible();
  await expect(article.getByRole("link", { name: "Committee submission", exact: true })).toBeVisible();
  await article.getByRole("button", { name: "Accept supported AI suggestion", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Accept AI priority for Supported comparison", exact: true });
  await dialog.getByLabel("Reason for acceptance (required)").fill("Inspected the comparison and committee context");
  await page.route("**/api/plan", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Acceptance failed; retry safely" }) }), { times: 1 });
  await dialog.getByRole("button", { name: "Accept supported AI suggestion", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Acceptance failed");
  await expect(dialog.getByLabel("Reason for acceptance (required)")).toHaveValue("Inspected the comparison and committee context");
  expect((await planState(request)).placements.find(row => row.gap_id === supported)!.validated).toBe(false);
  await dialog.getByRole("button", { name: "Accept supported AI suggestion", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.goto(`/gaps/${supported}`);
  await expect(page.getByTestId("gap-priority")).toContainText("Priority validated");
  await page.getByTestId("gap-priority").getByRole("button", { name: "Inspect supporting references" }).click();
  await expect(page.getByTestId("gap-priority").getByText("Supports: This supplied record explains the committee evidence need").first()).toBeVisible();
  if (await page.getByRole("group", { name: "History", exact: true }).getAttribute("open") === null) await page.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(page.getByTestId("entity-history")).toContainText("Inspected the comparison and committee context");
  await expect(page.getByRole("list", { name: "Decision supporting references" })).toContainText("This supplied record explains the committee evidence need");

  await page.goto("/?place=plan&setting=all");
  await page.getByRole("button", { name: /^Older unsupported suggestion: High, priority not validated/ }).focus();
  await page.keyboard.press("Enter");
  const older = page.getByTestId("gap-panel");
  await expect(older).toContainText("Supporting references not recorded for this suggestion");
  await expect(older).toContainText("Reason not recorded");
  await expect(older.getByRole("button", { name: "Accept supported AI suggestion", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(older).toBeHidden();
  const beforeRun = await newestRunId(request, "S8");
  await page.getByRole("button", { name: "Re-suggest unvalidated", exact: true }).click();
  await waitForNewRun(request, "S8", beforeRun);
  await page.getByRole("button", { name: /^Older unsupported suggestion: / }).focus();
  await page.keyboard.press("Enter");
  await expect(older).toContainText("Test stub: no model was called.");
  await expect(older).toContainText("Supporting references not recorded for this suggestion");
  await expect(older.getByRole("button", { name: "Accept supported AI suggestion", exact: true })).toHaveCount(0);
  await older.getByRole("button", { name: "Make manual judgement", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /^Validate .* priority for Older unsupported suggestion$/ });
  await expect(dialog).toContainText("explicit manual judgement");
  await dialog.getByLabel("Reason for change (required)").fill("My judgement from committee experience");
  await dialog.getByRole("button", { name: "Validate priority", exact: true }).click();
  await expect(dialog).toBeHidden();
  await planAction(request, { action: "set_placement", gap_id: legacy, band: "high", axis_scores: { decision_impact: 88, time_pressure: 77 }, rationale: "Human rationale retained on rerun", reason: "Refine the human scores" });
  const before = (await planState(request)).placements;
  await runStage(request, "S8", { x_axis: "decision_impact", y_axis: "time_pressure" });
  const after = (await planState(request)).placements;
  for (const gap_id of [supported, legacy, confirmed]) {
    expect(after.find(row => row.gap_id === gap_id)).toEqual(before.find(row => row.gap_id === gap_id));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/gaps/${legacy}`);
  await expect(page.getByTestId("gap-priority")).toContainText("Human rationale retained on rerun");
  if (await page.getByRole("group", { name: "History", exact: true }).getAttribute("open") === null) await page.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(page.getByTestId("entity-history")).toContainText("My judgement from committee experience");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
