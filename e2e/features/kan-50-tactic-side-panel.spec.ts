import { expect, test, type Page } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, iegpAction, runStage, seedMapped, validateBandHigh } from "../support/synapse";

test.describe.configure({ mode: "serial" });

// KAN-50: the design's tactic edit side panel on Tactic Ideation.
test.describe("tactic side panel", () => {
  let gapId = "";
  freshWorkspace({
    name: "KAN-50",
    seed: async (request) => {
      await seedMapped(request);
      await runStage(request, "S8");
      const gap = await firstOpenGap(request);
      gapId = gap.gap_id;
      await validateBandHigh(request, gap.gap_id, "High for the side panel test");
      // A proposed tactic mapped onto the gap, for the panel to edit.
      await iegpAction(request, {
        action: "create_tactic",
        origin: "tactics",
        gap_id: gap.gap_id,
        name: "Panel test registry study",
        type: "registry",
        evidence_question: "What is 12-month persistence in routine care?",
        status: "proposed",
        actor_name: "Feature E2E",
        actor_function: "medical_affairs",
      });
    },
  });

  async function openFirstLinked(page: Page) {
    await page.goto("/?place=tactics");
    const card = page.getByTestId("ideation-gap").filter({ hasText: gapId });
    const panel = page.getByTestId("tactic-panel");
    const row = card.getByRole("list").first().getByRole("button").first();
    await expect(async () => {
      await row.click({ timeout: 5_000 });
      await expect(panel).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    return { card, panel };
  }

  test("asks for a change and a rationale before saving", async ({ page }) => {
    test.setTimeout(90_000);
    const { panel } = await openFirstLinked(page);
    await panel.getByRole("button", { name: /^save changes$/i }).click();
    await expect(panel.getByRole("alert")).toHaveText("Nothing changed.");
    await panel.getByLabel(/^budget$/i).fill("$480K");
    await panel.getByRole("button", { name: /^save changes$/i }).click();
    await expect(panel.getByRole("alert")).toContainText(/rationale is required/i);
    await panel.getByRole("button", { name: /^cancel$/i }).click();
    await expect(panel).toBeHidden();
  });

  test("saves budget, lead and status without leaving the page", async ({ page }) => {
    test.setTimeout(90_000);
    const { panel } = await openFirstLinked(page);
    const name = await panel.getByLabel(/^tactic name$/i).inputValue();
    await panel.getByLabel(/^budget$/i).fill("$480K");
    await panel.getByLabel(/^lead \(owner\)$/i).fill("A. Rao");
    await panel.getByRole("combobox", { name: "Status" }).selectOption("planned");
    await panel.getByLabel(/why\? \(required\)/i).fill("Budget approved at the Q3 review");
    await panel.getByRole("button", { name: /^save changes$/i }).click();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(/place=tactics/);

    // Planned counts toward addressing, so the gap may leave Tactic Ideation; the library keeps the tactic.
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await library.getByRole("button", { name: /tactic library/i }).click();
    const item = library.getByRole("listitem").filter({ hasText: name });
    await expect(item).toContainText("planned");
    await item.getByRole("button", { name: /✎ edit/i }).click();
    await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$480K");
    await expect(panel.getByLabel(/^lead \(owner\)$/i)).toHaveValue("A. Rao");
    await expect(panel.getByRole("combobox", { name: "Status" })).toHaveValue("planned");
  });

  test("opens from the Tactic Library too", async ({ page }) => {
    await page.goto("/?place=tactics");
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await expect(async () => {
      await library.getByRole("button", { name: /tactic library/i }).click({ timeout: 5_000 });
      await expect(library.getByRole("searchbox", { name: /search library/i })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await library.getByRole("button", { name: /✎ edit/i }).first().click();
    await expect(page.getByTestId("tactic-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tactic-panel")).toBeHidden();
  });
});
