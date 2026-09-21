import { expect, test } from "@playwright/test";
import {
  clickRunStage,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  runStage,
  seedParsed,
} from "../support/synapse";

type GapExtractOutput = {
  mode: "llm" | "deterministic";
  proposed: number;
  accepted: { id: string; name: string; statement: string; source_quote: string; score: number }[];
  rejected: { id: string; critic_note: string }[];
  committed_gap_ids: string[];
  committed_need_ids: string[];
};

test.describe.configure({ mode: "serial" });

test.describe("S2 evidence gap extraction", () => {
  test.beforeAll(async ({ request }) => {
    await seedParsed(request);
  });

  test("extracts gaps from the pipeline page and commits what its judge accepted", async ({
    page,
    request,
  }) => {
    const run = await clickRunStage(page, request, "S2");
    expect(run.summary).toMatch(/new gap\(s\) committed/);
    expectRouteIsHonest(run);
    await expect(page.getByText(/gap candidate\(s\) accepted/).first()).toBeVisible();
  });

  test("debates three proposer↔critic exchanges before the judge", async ({ request }) => {
    const result = await runStage<GapExtractOutput>(request, "S2", { dry_run: true });
    const { rounds } = await expectThreeExchanges(request, result.run_id);
    expect(rounds[0]!.in).toBeGreaterThan(0);
    // The dialogue can only shrink or hold the candidate set, never grow it.
    expect(rounds[2]!.out).toBeLessThanOrEqual(rounds[0]!.in);
    expect(evalValue(result, "exchanges")).toBe(3);
    expect(evalValue(result, "dialogue_retention")).toBeGreaterThanOrEqual(0);
  });

  test("keeps a source quote and a constituent need on every committed gap", async ({ page, request }) => {
    const lists = await runStage<{ open: { gap_id: string; need_count: number }[]; addressed: { gap_id: string; need_count: number }[] }>(
      request,
      "S7",
    );
    const committed = [...lists.output.open, ...lists.output.addressed];
    expect(committed.length).toBeGreaterThan(0);
    for (const gap of committed) {
      expect(gap.need_count, `${gap.gap_id} needs provenance`).toBeGreaterThan(0);
    }

    await page.goto("/?place=gaps");
    await expect(page.getByRole("heading", { name: /^gaps$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^all \(/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /view constituent needs/i }).first()).toBeVisible();
  });

  test("scores itself against its gold cases", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S2", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { cases: number; metrics: { name: string; value: number }[] };
    expect(body.cases).toBeGreaterThan(0);
    expect(body.metrics.map((metric) => metric.name)).toContain("accepted_with_quote");
  });
});
