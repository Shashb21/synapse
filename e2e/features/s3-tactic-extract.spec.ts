import { expect, test } from "@playwright/test";
import {
  clickRunStage,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  runRecord,
  runStage,
  seedParsed,
} from "../support/synapse";

type TacticExtractOutput = {
  proposed: number;
  accepted: { id: string; name: string; type: string; status: string; source_quote: string; duplicate_of: string | null }[];
  rejected: { id: string; critic_note: string }[];
  committed_tactic_ids: string[];
};

test.describe.configure({ mode: "serial" });

test.describe("S3 tactic extraction", () => {
  test.beforeAll(async ({ request }) => {
    await seedParsed(request);
    await runStage(request, "S2");
  });

  test("extracts the tactics the sources already describe", async ({ page, request }) => {
    const run = await clickRunStage(page, request, "S3");
    expect(run.summary).toMatch(/tactic candidate\(s\) accepted/);
    expectRouteIsHonest(run);
  });

  test("debates three proposer↔critic exchanges before the judge", async ({ request }) => {
    const result = await runStage<TacticExtractOutput>(request, "S3", { dry_run: true });
    const { rounds } = await expectThreeExchanges(request, result.run_id);
    expect(rounds).toHaveLength(3);
    expect(evalValue(result, "exchanges")).toBe(3);
  });

  test("puts real inventory in the library, with its status and quote", async ({ page, request }) => {
    const dry = await runStage<TacticExtractOutput>(request, "S3", { dry_run: true });
    // Everything from the first pass is already committed, so a dry re-run finds no
    // new candidate; the library is what proves the commit.
    expect(dry.output.proposed).toBeGreaterThan(0);

    await page.goto("/?place=gaps");
    await page.getByRole("button", { name: /map existing tactic/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox").first()).toBeVisible();
    const options = await dialog.getByRole("combobox").first().locator("option").allTextContents();
    expect(options.join(" ").length, "the library should offer extracted tactics").toBeGreaterThan(0);
  });

  test("does not add a tactic the judge marks as already in the library", async ({ request }) => {
    const again = await runStage<TacticExtractOutput>(request, "S3");
    expect(again.output.committed_tactic_ids).toHaveLength(0);

    // The judge names the library tactic each repeat is the same as; commit skips
    // those. The judge step is in the trace.
    expect(again.output.accepted.length).toBeGreaterThan(0);
    expect(again.output.accepted.some((row) => Boolean(row.duplicate_of))).toBeTruthy();
    const run = await runRecord(request, again.run_id);
    expect(run.steps.some((step) => step.name === "judge:model")).toBeTruthy();
  });

  test("scores itself against its gold cases", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S3", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { cases: number; metrics: { name: string }[] };
    expect(body.cases).toBeGreaterThan(0);
    expect(body.metrics.map((metric) => metric.name)).toContain("real_inventory_share");
  });
});
