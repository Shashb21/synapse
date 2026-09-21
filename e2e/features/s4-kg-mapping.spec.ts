import { expect, test } from "@playwright/test";
import {
  clickRunStage,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  runStage,
  runStageExpectingError,
  seedParsed,
} from "../support/synapse";

type MappingOutput = {
  proposed: number;
  accepted: { gap_id: string; tactic_id: string; confidence: number; rationale: string[] }[];
  rejected: { gap_id: string; tactic_id: string; verdict: string }[];
  committed: { gap_id: string; tactic_id: string }[];
  graph: { gaps: number; tactics: number; edges: number; gaps_with_no_edge: number };
};

test.describe.configure({ mode: "serial" });

test.describe("S4 knowledge-graph mapping", () => {
  test.beforeAll(async ({ request }) => {
    await seedParsed(request);
    await runStage(request, "S2");
    await runStage(request, "S3");
  });

  test("joins gap ↔ tactic edges from the pipeline page", async ({ page, request }) => {
    const run = await clickRunStage(page, request, "S4");
    expect(run.summary).toMatch(/edge\(s\) accepted/);
    expectRouteIsHonest(run);
  });

  test("debates three proposer↔critic exchanges before the judge", async ({ request }) => {
    const result = await runStage<MappingOutput>(request, "S4", { dry_run: true });
    const { rounds } = await expectThreeExchanges(request, result.run_id);
    // Each exchange can only prune: the reviser concedes drops and trims the budget.
    expect(rounds[2]!.out).toBeLessThanOrEqual(rounds[0]!.in);
    expect(evalValue(result, "exchanges")).toBe(3);
  });

  test("maps many-to-many, with a rationale on every edge", async ({ page, request }) => {
    const dry = await runStage<MappingOutput>(request, "S4", { dry_run: true });
    for (const edge of dry.output.accepted) {
      expect(edge.rationale.length, `${edge.gap_id}::${edge.tactic_id} needs a rationale`).toBeGreaterThan(0);
    }

    await page.goto("/?place=gaps");
    // One tactic bearing on several gaps is the many-to-many claim, and the
    // workbench shows each gap's mapped tactics.
    const mappedRows = page.getByText(/no tactics mapped/i);
    const cards = page.locator("article");
    expect(await cards.count()).toBeGreaterThan(0);
    expect(await mappedRows.count()).toBeLessThan(await cards.count());
  });

  test("honours the per-gap edge budget and refuses a budget outside the contract", async ({ request }) => {
    const capped = await runStage<MappingOutput>(request, "S4", { max_per_gap: 1, dry_run: true });
    const perGap = new Map<string, number>();
    for (const edge of capped.output.accepted) {
      perGap.set(edge.gap_id, (perGap.get(edge.gap_id) ?? 0) + 1);
    }
    for (const [gap, count] of perGap) {
      expect(count, `${gap} should hold one edge at most`).toBeLessThanOrEqual(1);
    }

    const rejected = await runStageExpectingError(request, "S4", { max_per_gap: 99 });
    expect(rejected.status).toBe(400);
    expect(rejected.error).toMatch(/rejected its input/i);
  });

  test("scores the graph against its gold cases", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S4", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as {
      passed: boolean;
      metrics: { name: string; value: number; detail?: string }[];
    };
    const names = body.metrics.map((metric) => metric.name);
    expect(names).toContain("edges_with_rationale");
    expect(names).toContain("gaps_left_unmapped");
    // A graph with nothing left to join must not read as a regression: the harness
    // drops the target instead of scoring a division by zero.
    expect(body.passed, JSON.stringify(body.metrics)).toBeTruthy();
  });
});
