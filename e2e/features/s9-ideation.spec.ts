import { expect, test } from "@playwright/test";
import {
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
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
    const gap = await firstOpenGap(request);
    await validateBandHigh(request, gap.gap_id, "Blocks the EU5 submission, so it is High");
  });

  test("only ideates for gaps a human validated as High", async ({ page, request }) => {
    await page.goto("/ideation");
    await expect(page.getByRole("heading", { name: /ideation/i }).first()).toBeVisible();

    const result = await runStage<IdeationOutput>(request, "S9", { per_gap: 2 });
    expect(result.output.gaps_considered).toBeGreaterThan(0);
    const validated = (await planState(request)).placements.filter(
      (placement) => placement.validated && placement.band === "high",
    );
    expect(result.output.gaps_considered).toBeLessThanOrEqual(validated.length);
    for (const proposal of result.output.proposals) {
      expect(validated.some((placement) => placement.gap_id === proposal.gap_id)).toBe(true);
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
    expect(badDecision.error).toMatch(/decision: Invalid option/i);

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
});
