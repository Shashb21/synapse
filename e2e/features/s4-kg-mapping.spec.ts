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
  rows: { gap_id: string; tactic_ids: string[]; mapping_status: string; rationale: string[] }[];
  accepted: { gap_id: string; tactic_ids: string[]; mapping_status: string; rationale: string[] }[];
  rejected: { gap_id: string; verdict?: string }[];
  committed: { gap_id: string; tactic_ids: string[] }[];
  table: { gaps: number; tactics: number; rows_accepted: number; gaps_still_open: number };
};

test.describe.configure({ mode: "serial" });

test.describe("S4 LLM mapping table", () => {
  test.beforeAll(async ({ request }) => {
    await seedParsed(request);
    await runStage(request, "S2");
    await runStage(request, "S3");
  });

  test("produces mapping rows from the pipeline page", async ({ page, request }) => {
    const run = await clickRunStage(page, request, "S4");
    expect(run.summary).toMatch(/mapping row\(s\) accepted/);
    expectRouteIsHonest(run);
  });

  test("debates three proposer↔critic exchanges before the judge", async ({ request }) => {
    const result = await runStage<MappingOutput>(request, "S4", { dry_run: true });
    const { rounds } = await expectThreeExchanges(request, result.run_id);
    expect(rounds[2]!.out).toBeLessThanOrEqual(rounds[0]!.in);
    expect(evalValue(result, "exchanges")).toBe(3);
  });

  test("one row per gap with rationale", async ({ page, request }) => {
    const dry = await runStage<MappingOutput>(request, "S4", { dry_run: true });
    expect(dry.output.rows.length).toBeGreaterThan(0);
    for (const row of dry.output.accepted) {
      expect(row.rationale.length, `${row.gap_id} needs a rationale`).toBeGreaterThan(0);
    }

    await page.goto("/mappings");
    await expect(page.getByRole("heading", { name: /mapping table/i })).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("honours the per-gap tactic budget and refuses a budget outside the contract", async ({ request }) => {
    const capped = await runStage<MappingOutput>(request, "S4", { max_per_gap: 1, dry_run: true });
    for (const row of capped.output.accepted) {
      expect(row.tactic_ids.length, `${row.gap_id} should hold one tactic at most`).toBeLessThanOrEqual(1);
    }

    const rejected = await runStageExpectingError(request, "S4", { max_per_gap: 99 });
    expect(rejected.status).toBe(400);
    expect(rejected.error).toMatch(/rejected its input/i);
  });

  test("scores the table against its gold cases", async ({ request }) => {
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
    expect(names).toContain("rows_with_rationale");
    expect(names).toContain("gaps_left_unmapped");
    expect(body.passed, JSON.stringify(body.metrics)).toBeTruthy();
  });
});
