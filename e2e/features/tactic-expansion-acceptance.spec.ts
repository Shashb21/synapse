/** Scripted timeline mechanics. Real Corvantix/provider acceptance is recorded separately. */
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { COVERAGE_DIMENSIONS } from "../../src/lib/iegp/enums";
import { freshWorkspace } from "../support/session";
import { iegpAction, resetWorkspace, planAction, runStage, validateBandHigh } from "../support/synapse";

let tacticId = "";
const workspace = freshWorkspace({ name: "Expansion timeline acceptance", seed: async request => {
  await resetWorkspace(request);
  await iegpAction(request, {action: "create_gap", domain: "safety", statement: "Added evidence needed for community patients", rationale: "Browser fixture"});
  await iegpAction(request, {action: "record_missed_tactic", name: "Locked parent study", type: "rwe_study",
    evidence_question: "Original parent question", status: "ongoing", rationale: "Browser fixture"});
}});

test("schedules nested children, changes only child status, preserves scope and exports relationships", async ({page, request}) => {
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
    const beforeParents = await pg`select * from ${pg(`${schema}.tactics`)}`;
    const beforeScope = await pg`select id,scope from ${pg(`${schema}.tactic_expansions`)} order by id`;
    await validateBandHigh(request, String(gap!.id), "Timeline acceptance priority");
    for (const expansion_id of [undefined, "EXP-BROWSER-ONE", "EXP-BROWSER-TWO"]) {
      await planAction(request, {action: "add_activity", tactic_id: tacticId, expansion_id, start_date: "2026-10-08", end_date: "2027-01-01", rationale: "Team approved distinct dates"});
    }
    await page.goto("/timeline");
    const first = page.locator('[data-activity-id="ACT-EXP-EXP-BROWSER-ONE"]').first();
    await expect(first).toHaveAttribute("data-parent-activity-id", `ACT-${tacticId}`);
    await expect(first).toHaveAttribute("aria-label", /expansion of Locked parent study, proposed, not counting/);
    await first.click();
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Not counting toward addressing", {exact: true})).toBeVisible();
    await panel.getByRole("button", {name: "Change expansion status"}).click();
    const status = page.getByRole("dialog").last();
    await status.getByRole("combobox", {name: "Status", exact: true}).selectOption("planned");
    await status.getByLabel("Rationale (required)").fill("Funding approved for this added analysis");
    await status.getByRole("button", {name: "Save status", exact: true}).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(panel.getByText("counts toward addressing", {exact: true})).toBeVisible();
    await panel.getByRole("button", {name: "Edit", exact: true}).click();
    await expect(panel.getByLabel("Activity name", {exact: true})).toHaveCount(0);
    await panel.getByLabel("Start", {exact: true}).fill("2026-11-01");
    await panel.getByLabel("Rationale for the change").fill("Child analysis starts later");
    await panel.getByRole("button", {name: "Save changes", exact: true}).click();
    await expect(panel.getByTestId("activity-editor")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await planAction(request, {action: "set_dependencies", id: "ACT-EXP-EXP-BROWSER-TWO", depends_on: ["ACT-EXP-EXP-BROWSER-ONE"], rationale: "Second analysis needs first readout"});
    await planAction(request, {action: "remove_activity", id: "ACT-EXP-EXP-BROWSER-ONE", rationale: "Temporarily paused"});
    await runStage(request, "S10", {persist: true});
    await page.reload();
    await expect(page.locator('[data-activity-id="ACT-EXP-EXP-BROWSER-TWO"]').first()).toBeVisible();
    await planAction(request, {action: "add_activity", tactic_id: tacticId, expansion_id: "EXP-BROWSER-ONE", rationale: "Restored approved analysis"});
    await runStage(request, "S10", {persist: true});
    await page.reload();
    await expect(first).toHaveAttribute("aria-label", /2026-11-01.*planned/);
    const svg = await page.locator("svg[role=img]").evaluate(node => node.outerHTML);
    expect(svg).toContain(`data-parent-activity-id="ACT-${tacticId}"`);
    expect(svg).toContain("expansion of Locked parent study");
    const saved = await planAction(request, {action: "save_plan", status: "final", note: "Nested activities reviewed"});
    expect(JSON.stringify(saved)).toContain("ACT-EXP-EXP-BROWSER-ONE");
    expect(await pg`select * from ${pg(`${schema}.tactics`)}`).toEqual(beforeParents);
    expect(await pg`select id,scope from ${pg(`${schema}.tactic_expansions`)} order by id`).toEqual(beforeScope);
    await page.screenshot({path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-7-timeline-desktop.png", fullPage: true});
  } finally { await pg.end(); }
});
