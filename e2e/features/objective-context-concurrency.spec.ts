import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { controlAction, iegpAction, planState } from "../support/synapse";
import type { PlanningContext } from "../../src/lib/iegp/planning-context";

test.use({ actionTimeout: 10_000 });
let setup: PlanningContext;
let objectiveIds: string[];
freshWorkspace({ name: "KAN130 reviewed snapshots", seed: async request => {
  await controlAction(request, { action: "set_ai_section", section: "prioritization", enabled: false });
  const saved = await iegpAction(request, { action: "save_product_setup", reason: "Initial decision context", context: {
    asset_name: "Context snapshots", objectives: [
      { name: "Objective A", key_decision: "Original committee decision", decision_date: "2028-06-30" },
      { name: "Objective B" }, { name: "Objective C" },
    ],
  } });
  setup = saved.context as PlanningContext;
  objectiveIds = setup.objectives.map(objective => objective.id);
} });
test.afterAll(async ({ request }) => {
  await controlAction(request, { action: "set_ai_section", section: "prioritization", enabled: true });
});

async function newGap(request: APIRequestContext, name: string) {
  const created = await iegpAction(request, { action: "create_gap", name, statement: `${name} evidence is missing.`, domain: "comparative_effectiveness" });
  const id = String(created.id);
  await iegpAction(request, { action: "validate_gap", gap_id: id });
  const record = await (await request.get(`/api/gaps/${id}`)).json();
  if (record.gap.objective_id !== objectiveIds[0]) {
    await iegpAction(request, { action: "set_gap_objective", gap_id: id, expected_objective_id: record.gap.objective_id, objective_id: objectiveIds[0], rationale: "This test gap serves the first objective" });
  }
  return id;
}
async function openFirstPriority(page: Page, name: string) {
  await page.goto("/?place=plan&setting=all");
  await page.getByTestId("unplaced-gap").filter({ hasText: name }).click();
  await page.getByRole("button", { name: "Set priority", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('select[name="band"]').selectOption("high");
  await dialog.locator('select[name="validate"]').selectOption("yes");
  await dialog.getByLabel(/^Reason for change/).fill("Reviewed High priority for this decision");
  return dialog;
}

test("a stale first High confirmation keeps input and succeeds after reviewing refreshed context", async ({ page, request }) => {
  const gapId = await newGap(request, "First priority snapshot");
  let dialog = await openFirstPriority(page, "First priority snapshot");
  const changed = structuredClone(setup);
  changed.objectives[0]!.key_decision = "Updated committee remit";
  setup = (await iegpAction(request, { action: "save_product_setup", context: changed, reason: "Committee changed the decision remit" })).context as PlanningContext;
  await dialog.getByRole("button", { name: "Save placement", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Priority context changed");
  await expect(dialog.locator('select[name="band"]')).toHaveValue("high");
  await expect(dialog.getByLabel(/^Reason for change/)).toHaveValue("Reviewed High priority for this decision");
  expect((await planState(request)).placements.some(row => row.gap_id === gapId)).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  dialog = await openFirstPriority(page, "First priority snapshot");
  await dialog.getByRole("button", { name: "Save placement", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await planState(request)).placements.find(row => row.gap_id === gapId)).toMatchObject({ band: "high", validated: true });
});

test("objective reassignment requires a reason and retains the selected objective and reason after a stale refusal", async ({ page, request }) => {
  const gapId = await newGap(request, "Objective assignment snapshot");
  const initialHistory = (await (await request.get(`/api/gaps/${gapId}`)).json()).history.filter((entry: { field: string }) => entry.field === "objective").length;
  await page.goto(`/gaps/${gapId}`);
  await page.getByRole("button", { name: "Change objective", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Why (optional)", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/No supporting reference is required/)).toBeVisible();
  const reason = dialog.getByLabel(/^Reason for objective change \(required\)/);
  await dialog.locator('select[name="objective_id"]').selectOption(objectiveIds[1]!);
  await dialog.getByRole("button", { name: "Save objective", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(/rationale is required|reason is required/i);
  await expect(dialog.locator('select[name="objective_id"]')).toHaveValue(objectiveIds[1]!);
  expect((await (await request.get(`/api/gaps/${gapId}`)).json()).gap.objective_id).toBe(objectiveIds[0]);
  await reason.fill("Evidence now serves the second objective");
  await iegpAction(request, { action: "set_gap_objective", gap_id: gapId, objective_id: objectiveIds[2], expected_objective_id: objectiveIds[0], rationale: "Another editor assigned the third objective" });
  await dialog.getByRole("button", { name: "Save objective", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Objective assignment changed");
  await expect(dialog.locator('select[name="objective_id"]')).toHaveValue(objectiveIds[1]!);
  await expect(reason).toHaveValue("Evidence now serves the second objective");
  expect((await (await request.get(`/api/gaps/${gapId}`)).json()).gap.objective_id).toBe(objectiveIds[2]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Change objective", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator('select[name="objective_id"]').selectOption(objectiveIds[1]!);
  await dialog.getByLabel(/^Reason for objective change \(required\)/).fill("Reviewed the current assignment; choose the second objective");
  await dialog.getByRole("button", { name: "Save objective", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const record = await (await request.get(`/api/gaps/${gapId}`)).json();
  expect(record.gap.objective_id).toBe(objectiveIds[1]);
  const history = record.history.filter((entry: { field: string }) => entry.field === "objective");
  expect(history).toHaveLength(initialHistory + 2);
  expect(history.some((entry: { rationale: string }) => entry.rationale === "Reviewed the current assignment; choose the second objective")).toBe(true);
});
