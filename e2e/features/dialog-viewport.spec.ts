import { expect, test } from "@playwright/test";
import { firstOpenGap, runStage, seedMapped, validateBandHigh } from "../support/synapse";

/**
 * Long dialogs fit a laptop screen: the dialog is capped to the viewport and
 * scrolls, so its title and its submit button can both be reached.
 */
test.describe.configure({ mode: "serial" });

test.describe("Dialogs fit the viewport", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
    const gap = await firstOpenGap(request);
    await validateBandHigh(request, gap.gap_id, "Blocks the EU5 submission, so it is High");
  });

  test("Add idea by hand scrolls to its submit button at 1280x720", async ({ page }) => {
    await page.goto("/ideation");
    await page.getByRole("button", { name: "Add idea by hand" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box, "dialog has a box").not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(720);
    await expect(dialog.getByRole("heading").first()).toBeInViewport();

    await dialog.getByLabel("Name", { exact: true }).fill("Viewport check idea");
    await dialog.getByLabel("Evidence question").fill("Does the dialog fit the screen?");
    await dialog.getByPlaceholder("Why this decision, in one line").fill("A person can reach the submit button");

    const submit = dialog.getByRole("button", { name: "Add idea" });
    // The footer sticks to the bottom of the scrolling dialog, so the submit button stays on screen.
    await expect(submit).toBeInViewport();
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Viewport check idea").first()).toBeVisible();
  });
});
