import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, seedMapped } from "../support/synapse";

test.describe.configure({ mode: "serial" });

// KAN-49 / KAN-52: the gap's details are on screen and editable from the start.
test.describe("gap details", () => {
  freshWorkspace({ name: "KAN-49", seed: (request) => seedMapped(request) });

  test.setTimeout(90_000);

  test("typed on the gap page, saved, and shown on the Evidence Inventory row", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    await page.goto(`/gaps/${gap.gap_id}`);
    const details = page.getByTestId("gap-metadata");
    const save = details.getByRole("button", { name: "Save details" });
    await expect(page.getByRole("button", { name: /^(add|edit) details$/i })).toHaveCount(0);
    await expect(save).toBeDisabled();

    const stakeholders = details.getByLabel("Impacted stakeholders");
    // Retry until the page has hydrated: typing before that does not enable Save.
    await expect(async () => {
      await stakeholders.fill("");
      await stakeholders.fill("Payers, HTA bodies, payers");
      await expect(save).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await details.getByLabel("Geography").fill("US, EU5");
    await details.getByLabel("Regional nuances").fill("Germany: G-BA wants a head-to-head comparator.");
    await save.click();
    await expect(details.getByRole("status")).toHaveText("Details saved.");
    // Case-insensitive duplicates collapse to the first spelling.
    await expect(stakeholders).toHaveValue("Payers, HTA bodies");
    await expect(save).toBeDisabled();

    await page.reload();
    await expect(page.getByTestId("gap-metadata").getByLabel("Geography")).toHaveValue("US, EU5");

    await page.goto("/?place=gaps");
    const inventory = page.getByTestId("evidence-inventory");
    const row = inventory.locator("tr").filter({ has: page.getByRole("cell", { name: gap.gap_id, exact: true }) });
    const toggle = row.getByTestId("gap-row-toggle");
    await expect(async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click({ timeout: 5_000 });
      await expect(inventory.getByTestId("gap-metadata").getByLabel("Geography")).toHaveValue("US, EU5", { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  });
});
