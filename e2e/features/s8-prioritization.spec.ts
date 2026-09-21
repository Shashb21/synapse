import { expect, test } from "@playwright/test";
import {
  controlAction,
  controlActionExpectingError,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  firstOpenGap,
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
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
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

  test("plots the gaps as cards on the matrix, not as a list", async ({ page }) => {
    await page.goto("/matrix");
    await expect(page.getByRole("heading", { name: /^prioritization matrix$/i })).toBeVisible();
    await expect(page.locator("svg").first()).toBeVisible();
    await expect(page.getByText(/band\(s\) validated/)).toBeVisible();
    await expect(page.getByText(/dashed edge means the band is still only an S8 suggestion/)).toBeVisible();
    // Gaps are placed as cards; where several share a slot they collapse into one
    // cluster card that opens into the individual ones.
    await expect(page.getByText(/Suggested (High|Medium|Low)|Validated (High|Medium|Low)/).first()).toBeAttached();
    await expect(page.getByText(/gaps here|Suggested (High|Medium|Low)|Validated (High|Medium|Low)/).first()).toBeVisible();
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
    expect(badBand.error).toMatch(/band: Invalid option/i);

    await validateBandHigh(request, gap.gap_id, "Blocks the EU5 reimbursement dossier");
    const after = await planState(request);
    const placement = after.placements.find((row) => row.gap_id === gap.gap_id)!;
    expect(placement.validated).toBe(true);
    expect(placement.band).toBe("high");
    expect(placement.rationale).toMatch(/reimbursement dossier/);

    await page.goto("/matrix");
    // Co-located gaps share a cluster card, so the validated card may start collapsed.
    await expect(page.getByText(/Validated High/i).first()).toBeAttached();
    await expect(page.getByText(/[1-9]\d* of \d+ band\(s\) validated/)).toBeVisible();
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
