import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import {
  consolidate,
  controlAction,
  controlActionExpectingError,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  firstOpenGap,
  iegpAction,
  planAction,
  planActionExpectingError,
  planState,
  runStage,
  seedMapped,
  validateBandHigh,
} from "../support/synapse";

type PrioritizationOutput = {
  axes: { id: string; label: string; weight: number }[];
  placements: {
    gap_id: string;
    gap_name: string;
    axis_scores: Record<string, number>;
    score: number;
    suggested_band: "high" | "medium" | "low";
    rationale: string;
  }[];
  skipped: number;
};

test.describe.configure({ mode: "serial" });

test.describe("S8 prioritization matrix", () => {
  // Its own workspace: mapped demo gaps, every Open gap confirmed (Prioritize
  // shows only confirmed Open gaps), and two axes chosen for "All settings".
  freshWorkspace({
    name: "S8",
    seed: async (request) => {
      await seedMapped(request);
      for (const gap of (await consolidate(request)).open) {
        await iegpAction(request, { action: "validate_gap", gap_id: gap.gap_id });
      }
      const { axes } = (await planState(request)).axes;
      await planAction(request, { action: "save_scope_axes", scope: "all", x_axis: axes[0]!.id, y_axis: axes[1]!.id });
    },
  });

  test("suggests a band per open gap on the configured axes, through three exchanges", async ({ request }) => {
    const result = await runStage<PrioritizationOutput>(request, "S8");
    expect(result.output.placements.length).toBeGreaterThan(0);
    expect(result.output.axes.length).toBeGreaterThanOrEqual(2);
    for (const placement of result.output.placements) {
      for (const axis of result.output.axes) {
        expect(typeof placement.axis_scores[axis.id], `${placement.gap_id} needs a ${axis.id} score`).toBe(
          "number",
        );
      }
      expect(placement.rationale.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(placement.suggested_band);
    }
    const { run } = await expectThreeExchanges(request, result.run_id);
    expectRouteIsHonest(run);
    expect(evalValue(result, "exchanges")).toBe(3);
  });

  test("plots the gaps as cards on the matrix, not as a list", async ({ page, request }) => {
    const open = (await consolidate(request)).open;
    // The retired /matrix page now opens Prioritize.
    await page.goto("/matrix");
    await expect(page).toHaveURL(/\/\?place=plan$/);
    await page.goto("/?place=plan&setting=all");
    await expect(page.getByRole("heading", { name: /^prioritize$/i })).toBeVisible();
    const matrix = page.getByRole("group", { name: /^Prioritization matrix: / });
    await expect(matrix).toBeVisible();
    await expect(page.getByText(new RegExp(`\\b0 of ${open.length} validated`))).toBeVisible();
    await expect(page.getByText(/A dashed edge means the band is not validated yet/)).toBeVisible();
    // Each gap is a card on the plot, with its suggested band and not yet validated.
    const cards = matrix.getByRole("button", { name: /: (High|Medium|Low), not validated\. Arrow keys move it\.$/ });
    await expect(cards).toHaveCount(open.length);
  });

  test("takes a new axis configuration and refuses one the matrix cannot draw", async ({ request }) => {
    const before = await planState(request);
    const axes = before.axes.axes;
    const swapped = {
      ...before.axes,
      axes,
      x_axis: axes[2]?.id ?? axes[0]!.id,
      y_axis: axes[1]!.id,
      bands: before.axes.bands,
    };
    await controlAction(request, {
      action: "save_axes",
      config: {
        axes: swapped.axes,
        x_axis: swapped.x_axis,
        y_axis: swapped.y_axis,
        bands: swapped.bands,
      },
    });
    const after = await planState(request);
    expect(after.axes.x_axis).toBe(swapped.x_axis);

    const sameAxis = await controlActionExpectingError(request, {
      action: "save_axes",
      config: { axes, x_axis: axes[0]!.id, y_axis: axes[0]!.id, bands: before.axes.bands },
    });
    expect(sameAxis.status).toBe(400);
    expect(sameAxis.error).toMatch(/different axes/i);

    const badThreshold = await controlActionExpectingError(request, {
      action: "save_axes",
      config: { axes, x_axis: axes[0]!.id, y_axis: axes[1]!.id, bands: { high: 20, medium: 50 } },
    });
    expect(badThreshold.error).toMatch(/threshold/i);
  });

  test("rescoring follows the new axis weights", async ({ request }) => {
    const state = await planState(request);
    const axes = state.axes.axes.map((axis, index) => ({ ...axis, weight: index === 0 ? 5 : 0 }));
    await controlAction(request, {
      action: "save_axes",
      config: { axes, x_axis: state.axes.x_axis, y_axis: state.axes.y_axis, bands: state.axes.bands },
    });
    const rescored = await runStage<PrioritizationOutput>(request, "S8");
    const weights = new Map(rescored.output.axes.map((axis) => [axis.id, axis.weight]));
    expect(weights.get(axes[0]!.id)).toBe(5);
    expect(weights.get(axes[1]!.id)).toBe(0);
  });

  test("a band stays a suggestion until a human validates it with a rationale", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    const missingRationale = await planActionExpectingError(request, {
      action: "validate_band",
      gap_id: gap.gap_id,
      band: "high",
      rationale: "",
    });
    expect(missingRationale.status).toBe(400);

    const badBand = await planActionExpectingError(request, {
      action: "validate_band",
      gap_id: gap.gap_id,
      band: "urgent",
      rationale: "Not a band",
    });
    expect(badBand.error).toBe("Band must be one of: high, medium, low.");

    await validateBandHigh(request, gap.gap_id, "Blocks the EU5 reimbursement dossier");
    const after = await planState(request);
    const placement = after.placements.find((row) => row.gap_id === gap.gap_id)!;
    expect(placement.validated).toBe(true);
    expect(placement.band).toBe("high");
    expect(placement.rationale).toMatch(/reimbursement dossier/);

    await page.goto("/?place=plan&setting=all");
    const matrix = page.getByRole("group", { name: /^Prioritization matrix: / });
    await expect(matrix.getByRole("button", { name: /: High, validated\. Arrow keys move it\.$/ })).toHaveCount(1);
    await expect(page.getByText(/\b1 of \d+ validated/).first()).toBeVisible();
  });

  test("a re-run keeps the validated band and the suggestion the human judged", async ({ request }) => {
    const before = await planState(request);
    const validated = before.placements.find((row) => row.validated)!;
    await runStage(request, "S8");
    const after = await planState(request);
    const same = after.placements.find((row) => row.gap_id === validated.gap_id)!;
    expect(same.validated).toBe(true);
    expect(same.band).toBe(validated.band);
    expect(same.suggested_band).toBe(validated.suggested_band);
    expect(same.suggested_rationale).toBe(validated.suggested_rationale);
  });

  test("scores its suggestions against its gold case", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S8", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { metrics: { name: string; value: number }[]; passed: boolean };
    const names = body.metrics.map((metric) => metric.name);
    expect(names).toContain("axis_scores_complete");
    expect(names).toContain("suggestions_explained");
    expect(body.metrics.find((metric) => metric.name === "axis_scores_complete")!.value).toBe(1);
  });
});
