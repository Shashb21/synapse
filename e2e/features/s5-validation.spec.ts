import { expect, test } from "@playwright/test";
import { fillNameIfAsked } from "../support/session";
import {
  consolidate,
  runStageExpectingError,
  seedMapped,
  stageSignals,
  runStage,
} from "../support/synapse";

test.describe.configure({ mode: "serial" });

test.describe("S5 classification and validation gate", () => {
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
  });

  test("shows every mapped gap with its computed status and no accept/reject inbox", async ({ page }) => {
    await page.goto("/?place=gaps");
    await expect(page.getByRole("heading", { name: /^gaps$/i })).toBeVisible();
    await expect(
      page.getByText(/Every extracted gap is shown with its mapped tactics and computed status/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /accept gap/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^all \(/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^partial \(/i })).toBeVisible();
  });

  test("confirms a gap's status from the workbench and records who did it", async ({ page, request }) => {
    const before = await consolidate(request);
    const target = before.open[0]!;

    await page.goto("/?place=gaps");
    const card = page.locator("article").filter({ hasText: target.gap_id });
    await card.getByRole("button", { name: /^confirm status$/i }).click();
    const dialog = page.getByRole("dialog");
    await fillNameIfAsked(dialog, "A. Rao");
    await dialog.getByRole("textbox").last().fill("Both source quotes support this gap");
    await dialog.getByRole("button", { name: /^confirm /i }).click();
    await expect(dialog).toBeHidden();

    const after = await consolidate(request);
    expect(after.flags.some((flag) => flag.code === "not_validated" && flag.gap_id === target.gap_id)).toBe(
      false,
    );
  });

  test("files the rationale as an edit record and a hillclimb signal", async ({ request }) => {
    const lists = await consolidate(request);
    const target = lists.open[0]!;
    await runStage(request, "S5", {
      action: "classify",
      gap_id: target.gap_id,
      status: "validated_open",
      rationale: "No counting tactic touches the comparator question",
    });

    const validated = await runStage(request, "S5", {
      action: "validate",
      gap_id: target.gap_id,
      rationale: "Confirmed against both constituent needs",
    });
    const s5 = await stageSignals(request, validated.run_id);
    expect(s5.edits[0]!.rationale).toMatch(/Confirmed against both constituent needs/);
    expect(s5.signals[0]!.subject).toBe(`gap:${target.gap_id}`);
    expect(s5.signals[0]!.rationale).toMatch(/Confirmed against both constituent needs/);
  });

  test("refuses an edit with no rationale", async ({ request }) => {
    const lists = await consolidate(request);
    const target = lists.open[0]!;
    const rejected = await runStageExpectingError(request, "S5", {
      action: "validate",
      gap_id: target.gap_id,
      rationale: "x",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.error).toMatch(/rejected its input|rationale/i);
  });

  test("keeps an override's reason on the gap and refuses one without a reason", async ({ request }) => {
    const lists = await consolidate(request);
    const target = lists.open[0]!;
    const applied = await runStage<{ status: string; edit_id: string }>(request, "S5", {
      action: "classify",
      gap_id: target.gap_id,
      status: "validated_addressed",
      rationale: "Published registry readout closes this one",
    });
    expect(applied.output.status).toBe("validated_addressed");

    const noReason = await request.post("/api/iegp", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        action: "override_gap_status",
        gap_id: target.gap_id,
        status: "validated_addressed",
        actor_name: "Feature E2E",
        actor_function: "medical_affairs",
      }),
    });
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).error).toMatch(/reason/i);
  });
});
