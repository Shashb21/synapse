import postgres from "postgres";
import { expect, test } from "@playwright/test";
import {
  iegpAction,
  consolidate,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  firstOpenGap,
  planAction,
  planActionExpectingError,
  planState,
  runStage,
  seedMapped,
  validateBandHigh,
} from "../support/synapse";

type IdeationOutput = {
  proposals: {
    id: string;
    gap_id: string;
    name: string;
    type: string;
    rationale: string;
    evidence_question: string;
    design: {
      population: string;
      comparator: string;
      outcomes: string;
      data_source: string;
      study_design: string;
      duration_months: number;
      readout_lag_months: number;
    };
    score: number;
  }[];
  rejected: { id: string }[];
  gaps_considered: number;
};

test.describe.configure({ mode: "serial" });

test.describe("S9 tactics ideation", () => {
  let lowGap: { gap_id: string; name: string } | null = null;

  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
    const gap = await firstOpenGap(request);
    await validateBandHigh(request, gap.gap_id, "Blocks the EU5 submission, so it is High");
    // Low-priority gaps must remain excluded from S9.
    lowGap = (await consolidate(request)).open.find((row) => row.gap_id !== gap.gap_id) ?? null;
    if (lowGap) {
      await planAction(request, {
        action: "validate_band",
        gap_id: lowGap.gap_id,
        band: "low",
        rationale: "A later-cycle question, so it is Low",
      });
    }
  });

  test("ideation lists only High-priority gaps; a Low gap is not offered (KAN-8)", async ({ page }) => {
    test.skip(!lowGap, "the seed has only one open gap");
    await page.goto("/ideation");
    const waiting = page.getByTestId("ideation-without-proposal");
    await expect(waiting.getByRole("listitem").first()).toContainText("High priority");
    await expect(waiting.getByRole("listitem").filter({ hasText: lowGap!.name })).toHaveCount(0);
    await expect(waiting).not.toContainText("Low priority");
  });

  test("ideates for gaps a human validated as High only", async ({ page, request }) => {
    await page.goto("/ideation");
    await expect(page.getByRole("heading", { name: /ideation/i }).first()).toBeVisible();

    const result = await runStage<IdeationOutput>(request, "S9", { per_gap: 2 });
    expect(result.output.gaps_considered).toBeGreaterThan(0);
    const high = (await planState(request)).placements.filter(
      (placement) => placement.validated && placement.band === "high",
    );
    if (lowGap) {
      expect(result.output.proposals.some((proposal) => proposal.gap_id === lowGap!.gap_id)).toBe(false);
    }
    expect(result.output.gaps_considered).toBeLessThanOrEqual(high.length);
    for (const proposal of result.output.proposals) {
      expect(high.some((placement) => placement.gap_id === proposal.gap_id)).toBe(true);
    }
  });

  test("designs each proposal through three proposer↔critic exchanges", async ({ request }) => {
    const result = await runStage<IdeationOutput>(request, "S9", { per_gap: 2, dry_run: true });
    const { run } = await expectThreeExchanges(request, result.run_id);
    expectRouteIsHonest(run);
    expect(evalValue(result, "exchanges")).toBe(3);
  });

  test("every proposal is a runnable design, not a restated gap", async ({ request }) => {
    const result = await runStage<IdeationOutput>(request, "S9", { per_gap: 2, dry_run: true });
    expect(result.output.proposals.length).toBeGreaterThan(0);
    for (const proposal of result.output.proposals) {
      expect(proposal.design.duration_months).toBeGreaterThan(0);
      expect(proposal.design.study_design.trim().length).toBeGreaterThan(0);
      expect(proposal.design.data_source.trim().length).toBeGreaterThan(0);
      expect(proposal.rationale.trim().length).toBeGreaterThan(0);
      // A design is not a restatement of the gap it answers.
      expect(proposal.name).not.toBe(proposal.evidence_question);
    }
  });

  test("a proposal becomes a mapped tactic only when a human accepts it with a rationale", async ({
    page,
    request,
  }) => {
    const state = await planState(request);
    const pending = state.proposals.find((proposal) => proposal.status === "proposed")!;
    expect(pending, "S9 should leave a proposal awaiting review").toBeTruthy();

    const noRationale = await planActionExpectingError(request, {
      action: "decide_proposal",
      id: pending.id,
      decision: "accept",
      rationale: "",
    });
    expect(noRationale.status).toBe(400);

    const badDecision = await planActionExpectingError(request, {
      action: "decide_proposal",
      id: pending.id,
      decision: "maybe",
      rationale: "Undecided",
    });
    expect(badDecision.error).toBe("Decision must be one of: accept, reject.");

    const accepted = (await planAction(request, {
      action: "decide_proposal",
      id: pending.id,
      decision: "accept",
      rationale: "Cheapest design that answers the comparator question",
    })) as { tactic_id: string | null };
    expect(accepted.tactic_id).toBeTruthy();

    const after = await planState(request);
    const settled = after.proposals.find((proposal) => proposal.id === pending.id)!;
    expect(settled.status).toBe("accepted");
    expect(settled.tactic_id).toBe(accepted.tactic_id);
    expect(settled.decision_rationale).toMatch(/comparator question/);

    await page.goto("/ideation");
    await expect(page.getByText(/accepted/i).first()).toBeVisible();
  });

  test("reviews and edits a new proposal comparison", async ({ page, request }) => {
    const result = await runStage<IdeationOutput>(request, "S9", { per_gap: 1 });
    const proposal = result.output.proposals[0];
    expect(proposal).toBeTruthy();
    await page.goto("/ideation");
    const card = page.locator("article").filter({ has: page.getByRole("heading", { name: proposal.name, exact: true }) }).last();
    await expect(card).toContainText("New tactic");
    await expect(card).toContainText("Comparison: Test stub: no model comparison.");
    await card.getByRole("button", { name: `Edit ${proposal.name}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    const comparison = "A new registry adds unavailable outcomes; recruitment is feasible but costs more than secondary analysis.";
    await dialog.getByRole("textbox", { name: "Comparison of expansion and new tactic", exact: true }).fill(comparison);
    await dialog.getByLabel(/rationale.*required/i).last().fill("Clarified the alternative and feasibility");
    await dialog.getByRole("button", { name: "Save edit", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText(`Comparison: ${comparison}`);
    await page.reload();
    await expect(card).toContainText(`Comparison: ${comparison}`);
  });

  test("a rejection is recorded with its reason and creates no tactic", async ({ request }) => {
    const state = await planState(request);
    const pending = state.proposals.find((proposal) => proposal.status === "proposed");
    if (!pending) return;
    const rejected = (await planAction(request, {
      action: "decide_proposal",
      id: pending.id,
      decision: "reject",
      rationale: "Duplicates the registry we already fund",
    })) as { tactic_id: string | null };
    expect(rejected.tactic_id).toBeNull();
    const after = await planState(request);
    const settled = after.proposals.find((proposal) => proposal.id === pending.id)!;
    expect(settled.status).toBe("rejected");
    expect(settled.decision_rationale).toMatch(/registry we already fund/);
  });

  test("scores its designs against its gold case", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S9", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as {
      cases: number;
      passed: boolean;
      metrics: { name: string; value: number; detail?: string }[];
    };
    expect(body.cases).toBe(1);
    const names = body.metrics.map((metric) => metric.name);
    expect(names).toContain("gaps_covered");
    expect(names).toContain("designs_runnable");
    // Every proposal must be runnable; an empty proposal set is scored without a
    // target rather than as a regression.
    expect(body.passed, JSON.stringify(body.metrics)).toBeTruthy();
  });
  test("edits, rejects, restores and accepts an expansion without duplicating its parent", async ({page,request}) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(10_000);
    const gap = await firstOpenGap(request); await validateBandHigh(request,gap.gap_id,"Expansion blocks submission");
    await iegpAction(request,{action:"create_tactic",name:"S9 completed target",type:"phase3_trial",evidence_question:"Original safety",population:"Adults",outcomes:"AE",study_design:"Randomized trial",status:"completed",rationale:"Existing trial"});
    const workspace = await (await request.get("/api/workspaces")).json();
    const pg=postgres(process.env.DATABASE_URL!);
    try {
      const [w]=await pg`select schema_name from workspaces where id=${workspace.current_id}`;
      const schema=w.schema_name as string;
      const [parent]=await pg`select * from ${pg(`${schema}.tactics`)} where name='S9 completed target'`;
      const count=(await pg`select id from ${pg(`${schema}.tactics`)}`).length;
      const scope={name:"Elderly safety expansion",evidence_question:"Safety in 75+?",population:"Age 75+",outcomes:"AESI",geography:"",data_cut:"Locked trial data",analysis:"Post-hoc subgroup",instrument:"",study_design:"Retrospective subgroup",gap_coverage:"Elderly safety",cost_effort:"Two analyst months",timing:"3 months",feasibility_risks:"Small sample",post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
      const added=await planAction(request,{action:"add_proposal",gap_id:gap.gap_id,name:scope.name,type:"subgroup_analysis",evidence_question:scope.evidence_question,proposal_kind:"expansion",target_tactic_id:parent.id,expansion_scope:scope,comparative_rationale:"Existing data is faster and cheaper",duration_months:3,readout_lag_months:1,rationale:"Review expansion"});
      const proposal=added.proposal as {id:string};
      await page.goto("/ideation");
      const card=page.locator("article").filter({has:page.getByRole("heading",{name:scope.name,exact:true})});
      await expect(card).toContainText("Expand: S9 completed target"); await expect(card).toContainText("Reviewed current scope (completed): Adults; AE; Randomized trial");
      await card.getByRole("button",{name:`Edit ${scope.name}`,exact:true}).click();
      let dialog=page.getByRole("dialog");
      await dialog.getByRole("textbox",{name:"Added scope: cost effort",exact:true}).fill("One analyst month");
      await dialog.getByRole("textbox",{name:"Comparator",exact:true}).fill("Active comparator cohort");
      await dialog.getByRole("textbox",{name:"Data source",exact:true}).fill("Linked registry");
      await dialog.getByRole("textbox",{name:"Population",exact:true}).fill("Age 80+");
      await dialog.getByLabel(/rationale.*required/i).last().fill("Updated analyst budget");
      await dialog.getByRole("button",{name:"Save edit",exact:true}).click(); await expect(dialog).toBeHidden();
      await expect(card).toContainText("One analyst month");
      await runStage(request,"S9",{per_gap:1}); await page.reload(); await expect(card).toContainText("One analyst month");
      await card.getByRole("button",{name:`Reject ${scope.name}`,exact:true}).click(); dialog=page.getByRole("dialog");
      await dialog.getByLabel(/rationale.*required/i).fill("Small subgroup requires review"); await dialog.getByRole("button",{name:"Reject proposal",exact:true}).click(); await expect(dialog).toBeHidden();
      await card.getByRole("button",{name:`Restore ${scope.name}`,exact:true}).click(); dialog=page.getByRole("dialog");
      await dialog.getByLabel(/restore.*required/i).fill("New feasibility review"); await dialog.getByRole("button",{name:"Restore proposal",exact:true}).click(); await expect(dialog).toBeHidden();
      await expect(card).toContainText("One analyst month");
      await card.getByRole("button",{name:`Accept ${scope.name}`,exact:true}).click(); dialog=page.getByRole("dialog");
      await dialog.getByLabel(/rationale.*required/i).fill("Existing data answers the gap"); await dialog.getByRole("button",{name:"Accept proposal",exact:true}).click(); await expect(dialog).toBeHidden();
      await expect(card).toContainText("Accepted by");
      expect((await pg`select id from ${pg(`${schema}.tactics`)}`).length).toBe(count);
      const [child]=await pg`select * from ${pg(`${schema}.tactic_expansions`)} where proposal_id=${proposal.id}`;
      expect(child.status).toBe("proposed"); expect(child.scope.cost_effort).toBe("One analyst month");
      expect(child.scope).toMatchObject({type:"subgroup_analysis",population:"Age 80+",comparator:"Active comparator cohort",data_source:"Linked registry"});
      const [unchanged]=await pg`select * from ${pg(`${schema}.tactics`)} where id=${parent.id}`; expect(unchanged).toEqual(parent);
      const retry=await planActionExpectingError(request,{action:"decide_proposal",id:proposal.id,decision:"accept",rationale:"Duplicate click"}); expect(retry.error).toMatch(/already accepted/);
      await page.goto('/timeline');
      await page.locator(`[data-activity-id="ACT-EXP-${child.id}"]`).first().focus();
      await page.keyboard.press("Enter");
      const details=page.getByRole('dialog');
      await expect(details).toContainText('Active comparator cohort');
      await expect(details).toContainText('Linked registry');
      await expect(details).toContainText('Age 80+');
      await expect(details).toContainText('Subgroup');
      await planAction(request,{action:'add_activity',tactic_id:parent.id,expansion_id:child.id,start_date:'2026-11-01',end_date:'2027-02-01',rationale:'Independent child dates'});
      await page.reload();await page.locator(`[data-activity-id="ACT-EXP-${child.id}"]`).first().focus();
      await page.keyboard.press("Enter");
      await expect(details).toContainText('Active comparator cohort');await expect(details).toContainText('Linked registry');
      await page.screenshot({path:'.superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/final-fix-child-design.png',fullPage:true});
    } finally {await pg.end();}
  });

});
