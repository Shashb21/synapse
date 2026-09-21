import { expect, test } from "@playwright/test";
import {
  firstOpenGap,
  planAction,
  planActionExpectingError,
  planState,
  runStage,
  seedMapped,
  validateBandHigh,
} from "../support/synapse";

type TimelineOutput = {
  activities: {
    id: string;
    tactic_name: string;
    lane: string;
    start_date: string;
    end_date: string;
    readout_date: string | null;
    depends_on: string[];
    gap_ids: string[];
    gap_names: string[];
    meta: { evidence_question: string; comparator: string; dependency_note: string | null };
  }[];
  window: { start: string; end: string; months: number };
  lanes: { id: string; label: string; count: number }[];
  unscheduled: { gap_id: string }[];
};

test.describe.configure({ mode: "serial" });

test.describe("S10 interactive Gantt IEGP", () => {
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
    const gap = await firstOpenGap(request);
    await validateBandHigh(request, gap.gap_id, "Highest priority for the timeline spec");
    await runStage(request, "S10", { persist: true });
  });

  test("builds dated activities that each carry a gap and a tactic", async ({ request }) => {
    const built = await runStage<TimelineOutput>(request, "S10", { persist: false, anchor: "2026-01-01" });
    expect(built.output.activities.length).toBeGreaterThan(0);
    expect(built.output.window.months).toBeGreaterThan(0);
    for (const activity of built.output.activities) {
      expect(activity.gap_ids.length, `${activity.id} must answer a gap`).toBeGreaterThan(0);
      expect(activity.end_date >= activity.start_date).toBe(true);
      expect(activity.meta.evidence_question.length).toBeGreaterThan(0);
    }
    expect(built.output.lanes.map((lane) => lane.id)).toEqual(["high", "medium", "low", "addressed"]);
  });

  test("gates an activity on the readouts it depends on", async ({ request }) => {
    const built = await runStage<TimelineOutput>(request, "S10", { persist: false, anchor: "2026-01-01" });
    const dependent = built.output.activities.filter((activity) => activity.depends_on.length > 0);
    for (const activity of dependent) {
      for (const upstreamId of activity.depends_on) {
        const upstream = built.output.activities.find((candidate) => candidate.id === upstreamId)!;
        expect(
          activity.start_date >= (upstream.readout_date ?? upstream.end_date),
          `${activity.id} must wait for ${upstreamId}`,
        ).toBe(true);
      }
    }
  });

  test("renders the Gantt with lanes and a readout legend", async ({ page }) => {
    await page.goto("/timeline");
    await expect(page.getByRole("heading", { name: /^iegp timeline$/i })).toBeVisible();
    const chart = page.locator("svg[role='img']");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("aria-label", /Gantt timeline with \d+ activities/);
    await expect(page.getByText("HIGH PRIORITY", { exact: true })).toBeVisible();
    await expect(page.getByText("Readout", { exact: true })).toBeVisible();
    await expect(page.getByText("Depends on", { exact: true })).toBeVisible();
    await expect(page.getByText("Dashed bar outline = proposed tactic")).toBeVisible();
  });

  test("opens an activity's full record on click", async ({ page, request }) => {
    const state = await planState(request);
    const activity = state.timeline.activities[0]!;
    await page.goto("/timeline");
    await page.locator(`g[aria-label*="${activity.tactic_name.slice(0, 24)}"]`).first().click();

    const panel = page.getByRole("dialog");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Evidence gaps it answers" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Timing" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Design" })).toBeVisible();
    await expect(panel.getByText(activity.start_date)).toBeVisible();
    await expect(panel.getByRole("button", { name: /reschedule/i })).toBeVisible();
  });

  test("exports the chart as a PNG image", async ({ page }) => {
    await page.goto("/timeline");
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByRole("button", { name: /export png/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^synapse-iegp-v.*\.png$/);
    expect((await file.path()) ?? "").not.toBe("");
  });

  test("a reschedule needs a rationale and survives the next rebuild", async ({ request }) => {
    const state = await planState(request);
    const activity = state.timeline.activities[0]!;

    const backwards = await planActionExpectingError(request, {
      action: "move_activity",
      id: activity.id,
      start_date: "2028-01-01",
      end_date: "2027-01-01",
      rationale: "Impossible window",
    });
    expect(backwards.error).toMatch(/cannot end before it starts/i);

    const badDate = await planActionExpectingError(request, {
      action: "move_activity",
      id: activity.id,
      start_date: "next spring",
      rationale: "Vague date",
    });
    expect(badDate.error).toMatch(/start_date: expected YYYY-MM-DD/i);

    await planAction(request, {
      action: "move_activity",
      id: activity.id,
      start_date: "2027-03-01",
      end_date: "2027-11-01",
      rationale: "Site contracts slip to Q1 2027",
    });
    await runStage(request, "S10", { persist: true });
    const after = await planState(request);
    const moved = after.timeline.activities.find((row) => row.id === activity.id)!;
    expect(moved.start_date).toBe("2027-03-01");
  });

  test("saves the plan as final, versioned, with its sign-off rationale", async ({ page, request }) => {
    await page.goto("/timeline");
    await page.getByRole("button", { name: /save as final/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/why this decision/i).fill("Signed off for the feature spec");
    await dialog.getByRole("textbox", { name: /^name$/i }).fill("A. Rao");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByText(/Signed off for the feature spec/)).toBeVisible({ timeout: 20_000 });
    const state = await planState(request);
    expect(state.plan?.status).toBe("final");
    expect(state.plan?.note).toBe("Signed off for the feature spec");
    expect(state.plan?.version).toBeGreaterThan(0);
  });

  test("scores the timeline end to end against its gold case", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S10", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as {
      cases: number;
      passed: boolean;
      metrics: { name: string; value: number }[];
    };
    expect(body.cases).toBe(1);
    const names = body.metrics.map((metric) => metric.name);
    expect(names).toContain("dates_coherent");
    expect(names).toContain("dependencies_respect_readouts");
    expect(names).toContain("every_activity_carries_a_gap");
    expect(body.metrics.find((metric) => metric.name === "dates_coherent")!.value).toBe(1);
    expect(body.metrics.find((metric) => metric.name === "dependencies_respect_readouts")!.value).toBe(1);
  });
});
