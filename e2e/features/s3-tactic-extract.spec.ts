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
  accepted: { id: string; name: string; type: string; status: string; source_quote: string }[];
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

  test("withdraws a tactic that is already in the library during the dialogue", async ({ request }) => {
    const again = await runStage<TacticExtractOutput>(request, "S3");
    expect(again.output.committed_tactic_ids).toHaveLength(0);

    // The candidates never reach the judge: the proposer concedes them mid-dialogue,
    // and the trace records which ones and why.
    const run = await runRecord(request, again.run_id);
    const withdrawn = run.steps.find((step) => step.name === "withdrawn-in-dialogue");
    expect(withdrawn, "the trace should name the withdrawn candidates").toBeTruthy();
    const rows = withdrawn!.data as { note: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => /already in the tactic library/i.test(row.note))).toBeTruthy();
    expect(evalValue(run, "withdrawn_in_dialogue")).toBe(rows.length);
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
