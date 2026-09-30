import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, runStage, seedMapped, validateBandHigh } from "../support/synapse";
import { openIdeationCard } from "../support/ideation";

test.describe.configure({ mode: "serial" });

// KAN-51: a custom tactic type (name + colour) on top of the standard type.
test.describe("custom tactic types", () => {
  let gapId = "";
  freshWorkspace({
    name: "KAN-51",
    seed: async (request) => {
      await seedMapped(request);
      await runStage(request, "S8");
      const gap = await firstOpenGap(request);
      gapId = gap.gap_id;
      await validateBandHigh(request, gap.gap_id, "High for the custom type test");
    },
  });

  test("a custom tactic on Tactic Ideation gets a custom type and colour", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/?place=tactics");
    const card = await openIdeationCard(page, gapId);
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await card.getByRole("button", { name: /\+ custom tactic/i }).click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await dialog.getByPlaceholder("Tactic name").fill("Caregiver advisory board");
    await dialog.getByLabel("Tactic type").selectOption("patient_survey");
    await dialog.getByPlaceholder("Evidence question").fill("What burden do caregivers report?");
    await dialog.getByRole("button", { name: "+ Custom type" }).click();
    await dialog.getByLabel("Custom type name").fill("Advisory board");
    await dialog.getByRole("radio", { name: "#be185d" }).click();
    await expect(dialog.getByTestId("custom-type-preview")).toHaveText("Advisory board");

    // A bad hex is caught before saving.
    const hex = dialog.getByLabel("Custom type colour (hex)");
    await hex.fill("pink");
    await expect(dialog.getByText("Use a hex colour like #4f46e5.")).toBeVisible();
    await hex.fill("#be185d");
    await dialog.getByRole("button", { name: /^add tactic$/i }).click();
    await expect(dialog).toBeHidden();

    const row = card.getByRole("button", { name: /Caregiver advisory board/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Advisory board");
    await expect(row).not.toContainText("Patient / caregiver survey");

    await row.click();
    const panel = page.getByTestId("tactic-panel");
    await expect(panel.getByLabel("Custom type name")).toHaveValue("Advisory board");
    await panel.getByRole("link", { name: /open full page/i }).click();
    await expect(page.getByText(/Advisory board · counts as Patient \/ caregiver survey/i)).toBeVisible();
  });
});
