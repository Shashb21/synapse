import { expect, test } from "@playwright/test";
import {
  exchangesOf,
  expectThreeExchanges,
  modulesState,
  runRecord,
  runStage,
  runStageExpectingError,
  seedParsed,
} from "../support/synapse";

test.describe.configure({ mode: "serial" });

test.describe("Observability and the run trace", () => {
  test.beforeAll(async ({ request }) => {
    await seedParsed(request);
  });

  test("records every run with its route, steps, timing and eval scores", async ({ request }) => {
    const extract = await runStage(request, "S2");
    const run = await runRecord(request, extract.run_id);
    expect(run.status).toBe("ok");
    expect(run.steps.length).toBeGreaterThan(5);
    expect(run.route).toBeTruthy();
    expect(run.evals.length).toBeGreaterThan(0);
    expect(run.steps.some((step) => step.name === "input:accepted")).toBe(true);
    expect(run.steps.some((step) => step.name === "hillclimb:hints")).toBe(true);
  });

  test("shows all three rounds of the debate on the run page", async ({ page, request }) => {
    const extract = await runStage(request, "S2", { dry_run: true });
    const { rounds } = await expectThreeExchanges(request, extract.run_id);

    await page.goto(`/runs/${extract.run_id}`);
    await expect(page.getByRole("heading", { name: /proposer ↔ critic exchanges/i })).toBeVisible();
    for (const round of rounds) {
      await expect(page.getByRole("cell", { name: `Round ${round.round}`, exact: true })).toBeVisible();
    }
    await expect(page.getByText(/three exchanges before the judge sees anything/i)).toBeVisible();
    for (const step of [
      "round1:proposer",
      "round1:critic",
      "round1:proposer-revise",
      "round2:critic",
      "round3:critic",
      "judge",
    ]) {
      await expect(page.getByRole("heading", { name: step, exact: true })).toBeVisible();
    }
  });

  test("keeps the per-round critique payloads, so a decision can be reread", async ({ request }) => {
    const extract = await runStage(request, "S2", { dry_run: true });
    const run = await runRecord(request, extract.run_id);
    const critique = run.steps.find((step) => step.name === "round1:critic")!;
    const payload = critique.data as { subject: string; verdict: string; score: number }[];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBeGreaterThan(0);
    expect(payload[0]!.subject).toBeTruthy();
    expect(["keep", "revise", "drop"]).toContain(payload[0]!.verdict);

    const rounds = exchangesOf(run);
    expect(rounds[0]!.critiqued).toBe(payload.length);
  });

  test("lists stage health and recent runs on the runs page", async ({ page, request }) => {
    await runStage(request, "S3");
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /^runs$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^stage health$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^recent runs$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /S2 · s2-gap-extract\.pcj/ }).first()).toBeVisible();
    await expect(page.getByText(/Median duration/).first()).toBeVisible();
  });

  test("records a failed run with its reason rather than losing it", async ({ page, request }) => {
    const rejected = await runStageExpectingError(request, "S4", { max_per_gap: 99 });
    expect(rejected.status).toBe(400);

    const state = await modulesState(request);
    const failed = state.runs.find((run) => run.stage === "S4" && run.status === "error");
    expect(failed, "a contract violation must still be traced").toBeTruthy();
    expect(failed!.error).toMatch(/rejected its input/i);

    await page.goto(`/runs/${failed!.id}`);
    await expect(page.getByText(/rejected its input/i).first()).toBeVisible();
  });

  test("exposes what each stage is wired to and whether it can be scored", async ({ page, request }) => {
    const state = await modulesState(request);
    for (const stage of ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]) {
      const wiring = state.wiring.find((row) => row.stage === stage)!;
      expect(wiring.active, `${stage} needs an active module`).toBeTruthy();
    }
    // Every stage that ships gold cases can be scored from the pipeline page.
    const scorable = state.wiring.filter((row) => row.has_evals).map((row) => row.stage);
    expect(scorable).toEqual(
      expect.arrayContaining(["S1", "S2", "S3", "S4", "S6", "S7", "S8", "S9", "S10"]),
    );

    await page.goto("/pipeline");
    await expect(page.getByRole("button", { name: /run evals/i }).first()).toBeVisible();
  });
});
