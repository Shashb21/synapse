import { expect, test } from "@playwright/test";
import { iegpAction } from "../support/synapse";

/**
 * The Prep readiness strip shows the real next step. The demo opens
 * prioritized with Tactics unlocked, so on Timeline it reports prioritization
 * progress, not "Ready for Prioritize".
 */
test.describe.configure({ mode: "serial" });

test.describe("Prep readiness strip", () => {
  test.beforeAll(async ({ request }) => {
    await iegpAction(request, { action: "load_demo" });
  });

  test("on Timeline after Prioritize it says how far prioritization got and that Tactics is open", async ({
    page,
  }) => {
    await page.goto("/timeline");
    const strip = page.getByRole("status", { name: "Prep readiness" });
    await expect(strip).toContainText("4 of 4 validated · Tactics open");
    await expect(strip).not.toContainText("Ready for Prioritize");
  });
});
