/** Browser-only expansion fixture: source proposal acceptance is verified separately in Vitest. */
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { COVERAGE_DIMENSIONS } from "../../src/lib/iegp/enums";
import { freshWorkspace } from "../support/session";
import { iegpAction, resetWorkspace } from "../support/synapse";

let tacticId = "";
const workspace = freshWorkspace({ name: "Expansion details", seed: async request => {
  await resetWorkspace(request);
  await iegpAction(request, {action: "create_gap", domain: "safety", statement: "Added evidence needed for community patients", rationale: "Browser fixture"});
  await iegpAction(request, {action: "record_missed_tactic", name: "Locked parent study", type: "rwe_study",
    evidence_question: "Original parent question", status: "ongoing", rationale: "Browser fixture"});
}});

test("shows separate expansion scope, validates rationale and records human status history", async ({page}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const pg = postgres(process.env.DATABASE_URL!);
  try {
    const [row] = await pg`select schema_name from workspaces where id = ${workspace.id}`;
    const schema = row!.schema_name as string;
    const [parent] = await pg`select id from ${pg(`${schema}.tactics`)} where name = 'Locked parent study'`;
    const [gap] = await pg`select id from ${pg(`${schema}.gaps`)} limit 1`;
    tacticId = parent!.id as string;
    const actor = {name: "Feature E2E", function: "medical_affairs"};
    const at = "2026-10-07T12:00:00.000Z";
    const unlocked = {locked: false, actor_name: null, actor_function: null, locked_at: null, note: null};
    const dimensions = Object.fromEntries(COVERAGE_DIMENSIONS.map(key => [key, {value: "unknown", rationale: "", lock: unlocked}]));
    await pg`insert into ${pg(`${schema}.coverages`)} ${pg({id: "COV-BROWSER-PARENT", tactic_id: tacticId, gap_id: gap!.id,
      dimensions: pg.json(dimensions), overall: "limited", overall_rationale: "Locked parent assessment",
      overall_lock: pg.json({...unlocked, locked: true, actor_name: actor.name}), stale: false, needs_review: false})}`;
    for (const id of ["EXP-BROWSER-ONE", "EXP-BROWSER-TWO"]) {
      const scope = {name: id === "EXP-BROWSER-ONE" ? "Community expansion" : "Second expansion",
        evidence_question: "Added community question", population: "Community patients", outcomes: "ILD", geography: "US",
        data_cut: "2026", analysis: "Post-hoc subgroup", instrument: "", study_design: "Retrospective analysis",
        gap_coverage: "Community evidence", cost_effort: "Two analyst weeks", timing: "Q4", feasibility_risks: "Small subgroup",
        post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: "2026-10-08", evidence_available: "2026-12-01"};
      await pg`insert into ${pg(`${schema}.tactic_expansions`)} ${pg({id, tactic_id: tacticId, proposal_id: `browser:${id}`,
        gap_ids: pg.json([gap!.id]), scope: pg.json(scope), status: "proposed", version: id, created_at: at, updated_at: at,
        actor: pg.json(actor), history: pg.json([{action: "accept", at, actor, rationale: "Browser fixture accepted", status: "proposed", version: id}])})}`;
      await pg`insert into ${pg(`${schema}.coverages`)} ${pg({id: `COV-${id}`, tactic_id: tacticId, gap_id: gap!.id,
        expansion_id: id, dimensions: pg.json(dimensions), overall: "unassessed", overall_rationale: "Browser fixture",
        overall_lock: pg.json(unlocked), stale: false, needs_review: false})}`;
    }
    await page.goto(`/tactics/${tacticId}`);
    const section = page.getByRole("region", {name: "Tactic expansions"});
    await expect(section.getByRole("heading", {name: "Community expansion", exact: true})).toBeVisible();
    await expect(section.getByRole("heading", {name: "Second expansion", exact: true})).toBeVisible();
    await expect(section.getByText(/proposed · Does not count toward coverage/)).toHaveCount(2);
    const community = section.locator(":scope > div").filter({has: page.getByRole("heading", {name: "Community expansion", exact: true})});
    await community.getByRole("button", {name: "Review expansion coverage"}).click();
    const coverageDialog = page.getByRole("dialog");
    await coverageDialog.getByRole("combobox", {name: "Overall", exact: true}).selectOption("full");
    await coverageDialog.getByLabel("Rationale (required)").fill("Child question fully covered by added analysis");
    await coverageDialog.getByRole("button", {name: "Validate coverage", exact: true}).click();
    await expect(coverageDialog).toBeHidden({timeout: 30_000});
    await expect(section.getByText(/proposed · Does not count toward coverage/)).toHaveCount(2);
    await community.getByRole("button", {name: "Change expansion status"}).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", {name: "Status", exact: true}).selectOption("planned");
    await dialog.getByRole("button", {name: "Save status", exact: true}).click();
    await expect(dialog.getByText(/A short rationale is required/)).toBeVisible();
    await dialog.getByLabel("Rationale (required)").fill("Funding approved for community analysis");
    const statusResponse = page.waitForResponse(response => response.url().includes("/api/plan") && response.request().method() === "POST", {timeout: 30_000});
    await dialog.getByRole("button", {name: "Save status", exact: true}).click();
    const savedResponse = await statusResponse;
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    const persisted = await pg`select status from ${pg(`${schema}.tactic_expansions`)} where id = 'EXP-BROWSER-ONE'`;
    expect(persisted[0]!.status).toBe("planned");
    await expect(dialog).toBeHidden({timeout: 30_000});
    await expect(section.getByText(/planned · Eligible for coverage review/)).toBeVisible();
    await community.getByText("Scope history", {exact: true}).click();
    await expect(section.getByText(/Funding approved for community analysis/)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-4-details-desktop.png", fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await expect(section.getByRole("heading", {name: "Community expansion", exact: true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-4-details-mobile.png", fullPage: true});
    const [after] = await pg`select status, evidence_question from ${pg(`${schema}.tactics`)} where id = ${tacticId}`;
    expect(after).toMatchObject({status: "ongoing", evidence_question: "Original parent question"});
    expect((await pg`select * from ${pg(`${schema}.tactic_expansions`)}`).length).toBe(2);
    const [parentCoverage] = await pg`select overall, overall_lock from ${pg(`${schema}.coverages`)} where id = 'COV-BROWSER-PARENT'`;
    expect(parentCoverage).toMatchObject({overall: "limited", overall_lock: {locked: true}});
    const [childCoverage] = await pg`select overall, overall_lock from ${pg(`${schema}.coverages`)} where id = 'COV-EXP-BROWSER-ONE'`;
    expect(childCoverage).toMatchObject({overall: "full", overall_lock: {locked: true}});
  } finally { await pg.end(); }
});

test("split selects a counting child independently and gap details agree before and after cancellation", async ({page, request}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  await resetWorkspace(request);
  await iegpAction(request, {action: "create_gap", domain: "safety", name: "Scoped partial gap", statement: "Community and comparator evidence missing", rationale: "Browser split fixture"});
  await iegpAction(request, {action: "record_missed_tactic", name: "Scoped parent", type: "rwe_study", evidence_question: "Parent question", status: "ongoing", rationale: "Browser split fixture"});
  const pg = postgres(process.env.DATABASE_URL!);
  try {
    const [ws] = await pg`select schema_name from workspaces where id=${workspace.id}`;
    const schema = ws!.schema_name as string;
    const [gap] = await pg`select id from ${pg(`${schema}.gaps`)} limit 1`;
    const [parent] = await pg`select id from ${pg(`${schema}.tactics`)} where name='Scoped parent'`;
    const unlocked = {locked: false, actor_name: null, actor_function: null, locked_at: null, note: null};
    const actor = {name: "Feature E2E", function: "medical_affairs"};
    const at = new Date().toISOString();
    const scope = {name: "Counting community child", evidence_question: "Community question", population: "Community", outcomes: "ILD", geography: "US", data_cut: "2026", analysis: "Post-hoc", instrument: "", study_design: "Retrospective", gap_coverage: "Community", cost_effort: "Two weeks", timing: "Q4", feasibility_risks: "Small subgroup", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null};
    await pg`delete from ${pg(`${schema}.coverages`)}`;
    for (const [id, status, name] of [["EXP-SPLIT-COUNTING", "planned", scope.name], ["EXP-SPLIT-PROPOSED", "proposed", "Proposed sibling"]]) {
      await pg`insert into ${pg(`${schema}.tactic_expansions`)} ${pg({id, tactic_id: parent!.id, proposal_id: `browser:${id}`, gap_ids: pg.json([gap!.id]), scope: pg.json({...scope, name}), status, version: id, created_at: at, updated_at: at, actor: pg.json(actor), history: pg.json([{action: "accept", at, actor, rationale: "Browser split fixture", status: "proposed", version: id}])})}`;
      await pg`insert into ${pg(`${schema}.coverages`)} ${pg({id: `COV-${id}`, gap_id: gap!.id, tactic_id: parent!.id, expansion_id: id, dimensions: pg.json(Object.fromEntries(COVERAGE_DIMENSIONS.map(key => [key, {value: "unknown", rationale: "", lock: unlocked}]))), overall: "limited", overall_rationale: "Scoped fixture", overall_lock: pg.json(unlocked), stale: false, needs_review: false})}`;
    }
    await pg`update ${pg(`${schema}.gaps`)} set status='validated_partial', computed_status='validated_partial', human_validated=false where id=${gap!.id}`;
    await page.goto(`/gaps/${gap!.id}`);
    await expect(page.getByText("Engine computed Partially Addressed", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: /resolve this partially addressed gap/i}).click();
    const dialog = page.getByRole("dialog");
    const addressed = dialog.locator("section").filter({has: page.getByRole("heading", {name: "Addressed", exact: true})});
    await expect(addressed.getByRole("checkbox", {name: /Counting community child/})).toBeChecked();
    await expect(addressed.getByRole("checkbox", {name: /Proposed sibling|Scoped parent/})).toHaveCount(0);
    await addressed.getByRole("textbox", {name: "Title", exact: true}).fill("Community child addressed slice");
    const open = dialog.locator("section").filter({has: page.getByRole("heading", {name: "Open", exact: true})});
    await open.getByRole("textbox", {name: "Title", exact: true}).fill("Comparator still open");
    await dialog.getByPlaceholder(/why this split or rewrite/i).fill("Community child closes only its added scope");
    await page.screenshot({path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-4-fix1-split-dialog.png", fullPage: true});
    const saved = page.waitForResponse(r => r.url().includes("/api/iegp") && r.request().method() === "POST", {timeout: 15_000});
    await dialog.getByRole("button", {name: "Split gap", exact: true}).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).toBeHidden();
    const [closed] = await pg`select id from ${pg(`${schema}.gaps`)} where name='Community child addressed slice'`;
    const inherited = await pg`select expansion_id, tactic_id, overall from ${pg(`${schema}.coverages`)} where gap_id=${closed!.id}`;
    expect(inherited).toEqual([{expansion_id: "EXP-SPLIT-COUNTING", tactic_id: parent!.id, overall: "full"}]);
    await page.goto(`/gaps/${closed!.id}`);
    await expect(page.getByText("Engine computed Addressed", {exact: true})).toBeVisible();
    const [child] = await pg`select version from ${pg(`${schema}.tactic_expansions`)} where id='EXP-SPLIT-COUNTING'`;
    const cancel = await request.post("/api/plan", {data: {action: "set_expansion_status", expansion_id: "EXP-SPLIT-COUNTING", status: "cancelled", expected_version: child!.version, rationale: "Added analysis cancelled"}});
    expect(cancel.ok(), await cancel.text()).toBe(true);
    await page.reload();
    await expect(page.getByRole("status").filter({hasText: /computed from its mapped tactics is now Open/})).toBeVisible();
    const [cancelledGap] = await pg`select computed_status, status_override from ${pg(`${schema}.gaps`)} where id=${closed!.id}`;
    expect(cancelledGap).toMatchObject({computed_status: "validated_open", status_override: {status: "validated_addressed", stale: true}});
    const [base] = await pg`select status from ${pg(`${schema}.tactics`)} where id=${parent!.id}`;
    expect(base!.status).toBe("ongoing");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-4-fix1-gap-details.png", fullPage: true});
  } finally { await pg.end(); }
});
