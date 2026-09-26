import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_FALLBACK_WORKSPACE, demoSignIn, listWorkspaces, selectWorkspace } from "../support/session";
import { consolidate, controlAction, planState, seedMapped, validateBandHigh } from "../support/synapse";

/**
 * KAN-25: the owner builds the timeline by hand, with AI off and no S10 run.
 * Every prioritized gap is a group row with its tactics beneath it; the owner
 * adds an activity under a gap, drags it to reschedule, adds and removes a
 * dependency and sees the broken-dependency warning. A viewer sees the same
 * timeline with no edit controls, and the API refuses their writes.
 */

type GroupItem = {
  key: string;
  activity_id: string;
  tactic_id: string;
  tactic_name: string;
  activity: { start_date: string; end_date: string; depends_on: string[]; meta: { schedule_basis: { start: string } } } | null;
};
type TimelineView = {
  prioritized: { gap_id: string; gap_name: string; band: string; items: GroupItem[] }[];
  not_prioritized: { gap_id: string }[];
  conflicts: { predecessor_id: string; successor_id: string }[];
};

const NEW_ACTIVITY = "KAN-25 e2e registry follow-up";
const SECOND_ACTIVITY = "KAN-25 e2e registry publication";

async function timelineView(request: APIRequestContext): Promise<TimelineView> {
  const response = await request.get("/api/plan");
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { timeline_view: TimelineView }).timeline_view;
}

async function setAi(request: APIRequestContext, enabled: boolean) {
  await controlAction(request, {
    action: "set_ai_enabled",
    enabled,
    rationale: enabled ? "KAN-25 e2e: AI back on" : "KAN-25 e2e: manual timeline",
  });
}

/** Waits for the client to hydrate, so the first click is not swallowed. */
async function openTimeline(page: Page) {
  await page.goto("/timeline");
  await expect(page.getByRole("heading", { name: /^iegp timeline$/i })).toBeVisible();
  await expect(page.locator("svg[role='img']")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function saveDialog(page: Page, rationale: string, button: RegExp) {
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder(/why this decision/i).fill(rationale);
  await dialog.getByRole("button", { name: button }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("KAN-25 manual timeline", () => {
  let gapId: string;
  let gapName: string;

  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    const lists = await consolidate(request);
    expect(lists.open.length).toBeGreaterThan(0);
    gapId = lists.open[0]!.gap_id;
    gapName = lists.open[0]!.name;
    await validateBandHigh(request, gapId, "KAN-25: highest priority");
    // From here on everything is by hand: no model, no S10 run.
    await setAi(request, false);
  });

  test.afterAll(async ({ request }) => {
    await setAi(request, true);
  });

  test("shows the prioritized gap as a group row, unscheduled until dated, with no S10 run and AI off", async ({ page, request }) => {
    const view = await timelineView(request);
    const group = view.prioritized.find((row) => row.gap_id === gapId)!;
    expect(group.band).toBe("high");
    await openTimeline(page);
    await expect(page.getByText("HIGH PRIORITY", { exact: true })).toBeVisible();
    await expect(page.locator(`g[aria-label="Gap ${gapName}"]`)).toBeVisible();
    await expect(page.getByText("Unscheduled").first()).toBeVisible();
    if (view.not_prioritized.length > 0) {
      await expect(page.getByText(/^NOT PRIORITIZED · \d+$/)).toBeVisible();
      await page.getByRole("button", { name: /show not prioritized gaps/i }).click();
      await expect(page.getByRole("button", { name: /collapse not prioritized gaps/i })).toBeVisible();
    }
  });

  test("creates an activity under the gap from the timeline", async ({ page, request }) => {
    await openTimeline(page);
    await page.getByTestId(`gap-actions-${gapId}`).getByRole("button", { name: "Add activity" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Activity name").fill(NEW_ACTIVITY);
    await dialog.getByLabel("Type").selectOption("registry");
    await dialog.getByLabel("Start (optional)").fill("2026-11-01");
    await dialog.getByLabel("End (optional)").fill("2027-04-30");
    await saveDialog(page, "Added in the KAN-25 planning session", /^add activity$/i);

    const bar = page.locator(`g[aria-label^="${NEW_ACTIVITY}, 2026-11-01 to 2027-04-30"]`);
    await expect(bar).toBeVisible({ timeout: 20_000 });
    const group = (await timelineView(request)).prioritized.find((row) => row.gap_id === gapId)!;
    const item = group.items.find((row) => row.tactic_name === NEW_ACTIVITY)!;
    expect(item.activity?.meta.schedule_basis.start).toBe("human");
  });

  test("reschedules by dragging the bar, confirmed with a rationale", async ({ page, request }) => {
    const before = (await timelineView(request)).prioritized
      .find((row) => row.gap_id === gapId)!
      .items.find((row) => row.tactic_name === NEW_ACTIVITY)!;
    await openTimeline(page);
    const body = page.locator(`[data-activity-id="${before.activity_id}"] rect[data-bar="body"]`);
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Reschedule ${NEW_ACTIVITY}` })).toBeVisible();
    const start = await dialog.getByLabel("Start").inputValue();
    expect(start > "2026-11-01").toBe(true);
    await dialog.getByRole("button", { name: /save dates/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    await expect
      .poll(async () => (await planState(request)).timeline.activities.find((row) => row.id === before.activity_id)?.start_date)
      .toBe(start);
  });

  test("adds an unscheduled activity, dates it, adds a dependency that breaks, and sees the warning", async ({ page, request }) => {
    // A second activity with no dates: it shows under the gap as "Unscheduled".
    await openTimeline(page);
    await page.getByTestId(`gap-actions-${gapId}`).getByRole("button", { name: "Add activity" }).click();
    await page.getByRole("dialog").getByLabel("Activity name").fill(SECOND_ACTIVITY);
    await page.getByRole("dialog").getByLabel("Type").selectOption("publication");
    await saveDialog(page, "Publication follows the registry", /^add activity$/i);
    await expect(page.locator(`g[aria-label="${SECOND_ACTIVITY}, unscheduled"]`)).toBeVisible({ timeout: 20_000 });

    const group = (await timelineView(request)).prioritized.find((row) => row.gap_id === gapId)!;
    const predecessor = group.items.find((row) => row.tactic_name === NEW_ACTIVITY)!;
    const unscheduled = group.items.find((row) => row.tactic_name === SECOND_ACTIVITY);
    expect(unscheduled?.activity, "created with no dates").toBeNull();

    await openTimeline(page);
    await page.getByTestId(`item-actions-${unscheduled!.key}`).getByRole("button", { name: "Set dates" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Start").fill("2027-01-01");
    await dialog.getByLabel("End", { exact: true }).fill("2027-08-31");
    await saveDialog(page, "Dates from the study team", /save dates/i);

    // Open the successor and make it wait on the new activity, which ends later than it starts.
    const successor = page.locator(`g[aria-label^="${unscheduled!.tactic_name}, 2027-01-01"]`).first();
    await expect(successor).toBeVisible({ timeout: 20_000 });
    await successor.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: /edit dependencies/i }).click();
    dialog = page.getByRole("dialog", { name: /dependencies of/i });
    await dialog.getByRole("checkbox", { name: new RegExp(NEW_ACTIVITY) }).check();
    await dialog.getByPlaceholder(/why this decision/i).fill("Needs the registry cohort first");
    await dialog.getByRole("button", { name: /save dependencies/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await page.keyboard.press("Escape");

    const warning = page.getByRole("alert").filter({ hasText: /broken dependenc/i }).first();
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await expect(warning).toContainText(unscheduled!.tactic_name);
    await expect(page.locator("path[data-broken='true']")).toHaveCount(1);

    const view = await timelineView(request);
    expect(view.conflicts).toEqual([
      expect.objectContaining({ predecessor_id: predecessor.activity_id, successor_id: unscheduled!.activity_id }),
    ]);
    // Not auto-shifted: the successor keeps the start the person gave it.
    const state = await planState(request);
    expect(state.timeline.activities.find((row) => row.id === unscheduled!.activity_id)!.start_date).toBe("2027-01-01");
  });

  test("removes the dependency and the warning clears", async ({ page, request }) => {
    const group = (await timelineView(request)).prioritized.find((row) => row.gap_id === gapId)!;
    const successor = group.items.find((row) => row.activity?.depends_on.length)!;
    await openTimeline(page);
    await page.locator(`[data-activity-id="${successor.activity_id}"]`).first().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: /edit dependencies/i }).click();
    const dialog = page.getByRole("dialog", { name: /dependencies of/i });
    await dialog.getByRole("checkbox", { name: new RegExp(NEW_ACTIVITY) }).uncheck();
    await dialog.getByPlaceholder(/why this decision/i).fill("They can run in parallel");
    await dialog.getByRole("button", { name: /save dependencies/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await page.keyboard.press("Escape");

    await expect(page.getByRole("alert").filter({ hasText: /broken dependenc/i })).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator("path[data-dependency]")).toHaveCount(0);
    expect((await timelineView(request)).conflicts).toEqual([]);
  });

  test("a viewer sees the timeline read-only and the API refuses their edits", async ({ browser, request }) => {
    // Invite a viewer into the suite's workspace.
    const mine = await listWorkspaces(request);
    const workspace = mine.find((ws) => ws.id === "default") ?? mine.find((ws) => ws.name === E2E_FALLBACK_WORKSPACE)!;
    const email = `kan25.viewer.${Date.now()}@example.com`;
    const invited = await request.post(`/api/workspaces/${workspace.id}/members`, { data: { email } });
    expect(invited.ok(), await invited.text()).toBeTruthy();

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      await demoSignIn(context.request, { actor_name: "Viewer KAN-25", actor_function: "medical_affairs", email, role: "viewer" });
      await selectWorkspace(context.request, workspace.id);
      const page = await context.newPage();
      await openTimeline(page);
      await expect(page.getByText("HIGH PRIORITY", { exact: true })).toBeVisible();
      await expect(page.locator(`g[aria-label^="${NEW_ACTIVITY}"]`)).toBeVisible();
      await expect(page.getByText(/read-only/i).first()).toBeVisible();
      for (const name of ["Add activity", "Set dates", "Save as final", "Lay out dates"]) {
        await expect(page.getByRole("button", { name })).toHaveCount(0);
      }
      await expect(page.getByText(/drag a bar to move it/i)).toHaveCount(0);

      const state = await planState(context.request);
      const activity = state.timeline.activities.find((row) => row.tactic_name === NEW_ACTIVITY)!;
      const refused = await context.request.post("/api/plan", {
        data: { action: "move_activity", id: activity.id, start_date: "2028-01-01", end_date: "2028-06-01", rationale: "viewer" },
      });
      expect(refused.status()).toBe(403);
      const create = await context.request.post("/api/plan", {
        data: { action: "create_activity", gap_id: gapId, name: "x", type: "registry", evidence_question: "q", rationale: "viewer" },
      });
      expect(create.status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});
