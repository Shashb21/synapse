import { expect, test } from "@playwright/test";
import {
  clickRunStage,
  consolidate,
  runStage,
  seedMapped,
  type ConsolidationOutput,
} from "../support/synapse";

test.describe.configure({ mode: "serial" });

test.describe("S7 open / addressed consolidation", () => {
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
  });

  test("derives the lists from the pipeline page and writes nothing", async ({ page, request }) => {
    const before = await consolidate(request);
    const run = await clickRunStage(page, request, "S7");
    expect(run.summary).toMatch(/\d+ open, \d+ addressed, \d+ flag\(s\)/);

    const after = await consolidate(request);
    expect(after.open.map((gap) => gap.gap_id).sort()).toEqual(before.open.map((gap) => gap.gap_id).sort());
  });

  test("keeps the open and addressed lists disjoint and every listed gap traceable", async ({ request }) => {
    const lists = await consolidate(request);
    const open = new Set(lists.open.map((gap) => gap.gap_id));
    for (const gap of lists.addressed) {
      expect(open.has(gap.gap_id), `${gap.gap_id} cannot be open and addressed`).toBe(false);
    }
    expect(lists.open.length + lists.addressed.length).toBeGreaterThan(0);
  });

  test("flags every unresolved partial and blocks prioritization until the gates are done", async ({
    request,
  }) => {
    const lists = await consolidate(request);
    for (const partial of lists.unresolved_partials) {
      expect(
        lists.flags.some((flag) => flag.code === "partial_unresolved" && flag.gap_id === partial.gap_id),
      ).toBe(true);
    }
    if (lists.unresolved_partials.length > 0) {
      expect(lists.ready_for_prioritization).toBe(false);
    }
  });

  test("flags a gap that was overridden to Addressed with no counting evidence", async ({ request }) => {
    const lists = await consolidate(request);
    const target = lists.open[0]!;
    await runStage(request, "S5", {
      action: "classify",
      gap_id: target.gap_id,
      status: "validated_addressed",
      rationale: "Override for the consistency check",
    });
    const after = await runStage<ConsolidationOutput>(request, "S7");
    expect(
      after.output.flags.some(
        (flag) => flag.code === "addressed_without_evidence" && flag.gap_id === target.gap_id,
      ),
      "an Addressed gap with no counting tactic must be flagged",
    ).toBe(true);
  });

  test("scores consistency on its own gold case", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S7", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { cases: number; metrics: { name: string; value: number }[] };
    expect(body.cases).toBe(1);
    const names = body.metrics.map((metric) => metric.name);
    expect(names).toContain("provenance_on_every_listed_gap");
    expect(names).toContain("partials_all_flagged");
    expect(body.metrics.find((metric) => metric.name === "lists_disjoint")!.value).toBe(1);
    expect(body.metrics.find((metric) => metric.name === "partials_all_flagged")!.value).toBe(1);
  });
});
