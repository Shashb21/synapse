import { expect, test } from "@playwright/test";
import {
  consolidate,
  firstOpenGap,
  planAction,
  runStage,
  seedMapped,
  validateBandHigh,
} from "../support/synapse";

test.describe.configure({ mode: "serial" });

// KAN-8: Tactic Ideation from the Figma design. High-priority gaps only, as collapsible cards.
test.describe("Tactic Ideation place", () => {
  let high: { gap_id: string; name: string };
  let low: { gap_id: string; name: string } | null = null;

  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
    high = await firstOpenGap(request);
    await validateBandHigh(request, high.gap_id, "Blocks the EU5 submission, so it is High");
    low = (await consolidate(request)).open.find((row) => row.gap_id !== high.gap_id) ?? null;
    if (low) {
      await planAction(request, {
        action: "validate_band",
        gap_id: low.gap_id,
        band: "low",
        rationale: "Useful, but not this cycle",
      });
    }
  });

  test("lists only the gaps validated as High, the first one open", async ({ page }) => {
    await page.goto("/?place=tactics");
    await expect(page.getByRole("heading", { name: /^tactic ideation$/i })).toBeVisible();
    const board = page.getByTestId("tactic-ideation");
    const toggles = board.getByTestId("ideation-gap-toggle");
    await expect(toggles.filter({ hasText: high.gap_id })).toHaveAttribute("aria-expanded", "true");
    if (low) await expect(toggles.filter({ hasText: low.gap_id })).toHaveCount(0);
    await expect(board.getByText(/other open gaps? (is|are) medium, low or not validated yet/i)).toHaveCount(0);
    await expect(page.getByText(/other open gaps? (is|are) medium, low or not validated yet/i)).toBeVisible();
  });

  test("filters by search and by whether a gap has tactics", async ({ page }) => {
    await page.goto("/?place=tactics");
    const board = page.getByTestId("tactic-ideation");
    await expect(board.getByText(/^1 of 1$/)).toBeVisible();
    const search = board.getByRole("searchbox", { name: /search high-priority gaps/i });
    // Retry until the page has hydrated; typing before that changes nothing.
    await expect(async () => {
      await search.fill("");
      await search.fill("zzz-no-such-gap");
      await expect(board.getByText("No gaps match the current filters.")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await board.getByRole("combobox", { name: /filter by tactics/i }).selectOption("unlinked");
    await board.getByRole("button", { name: /^clear$/i }).click();
    await expect(board.getByTestId("ideation-gap")).toHaveCount(1);
  });

  test("collapses and expands a gap card", async ({ page }) => {
    await page.goto("/?place=tactics");
    const toggle = page.getByTestId("ideation-gap-toggle").first();
    await expect(async () => {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /\+ custom tactic/i })).toHaveCount(0);
    await toggle.click();
    await expect(page.getByRole("button", { name: /\+ custom tactic/i })).toBeVisible();
  });

  test("a custom tactic is created and linked to the gap", async ({ page }) => {
    const name = `Custom ideation tactic ${Date.now()}`;
    await page.goto("/?place=tactics");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /\+ custom tactic/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Tactic name").fill(name);
    await dialog.getByRole("combobox", { name: /tactic type/i }).selectOption("rwe_study");
    await dialog.getByPlaceholder("Evidence question").fill("Does it hold in routine care?");
    await dialog.getByRole("button", { name: /^add tactic$/i }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId("ideation-gap").filter({ hasText: high.gap_id });
    await expect(card.getByRole("link", { name: new RegExp(name) })).toBeVisible();
  });

  test("the library opens, searches, and marks unassigned tactics", async ({ page }) => {
    await page.goto("/?place=tactics");
    const library = page.getByRole("region", { name: /^tactic library$/i });
    const toggle = library.getByRole("button", { name: /tactic library/i });
    // Click only while closed: a slow retry must not close what the last click opened.
    await expect(async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect(library.getByRole("searchbox", { name: /search library/i })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await library.getByRole("searchbox", { name: /search library/i }).fill("zzz-no-such-tactic");
    await expect(library.getByText("No tactics match.")).toBeVisible();
  });
});

// KAN-8: the Gantt Timeline toolbar from the design; the chart stays editable.
test.describe("Gantt Timeline toolbar", () => {
  test("filters by priority and toggles dependency arrows", async ({ page }) => {
    await page.goto("/timeline");
    await expect(page.getByRole("heading", { name: /^gantt timeline$/i })).toBeVisible();
    const toolbar = page.getByRole("toolbar", { name: /timeline filters/i });
    await expect(toolbar).toBeVisible();
    const chart = page.locator('svg[role="img"]').first();
    const all = toolbar.getByRole("button", { name: /^all gaps$/i });
    const high = toolbar.getByRole("button", { name: /^high priority$/i });
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
      await high.click();
      await expect(high).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(chart).not.toContainText(/NOT PRIORITIZED|MEDIUM PRIORITY|LOW PRIORITY/);
    await expect(chart).toContainText("HIGH PRIORITY");
    await all.click();

    const deps = toolbar.getByRole("button", { name: /dependencies/i });
    await expect(deps).toHaveAttribute("aria-pressed", "true");
    await deps.click();
    await expect(deps).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-dependency]")).toHaveCount(0);
  });
});
