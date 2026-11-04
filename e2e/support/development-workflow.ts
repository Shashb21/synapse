/** Explicit workflow navigation shared by Development browser scenarios. */
import { expect, type Page } from "@playwright/test";

/** Move to a step through the same ordered navigation used by an owner. */
export async function developmentStep(page: Page, step: "Documents" | "Test settings" | "Run" | "Results") {
  await page.getByRole("navigation", { name: "Experiment workflow" }).getByRole("button", { name: new RegExp(`^\\d\\. ${step}`) }).click();
}

/** Reveal an optional disclosure without accidentally closing an already open one. */
export async function developmentDetails(page: Page, label: string) {
  const summary = page.locator("summary").filter({ hasText: label }).first();
  if (label === "New experiment") await expect(summary).toHaveAttribute("aria-disabled", "false");
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
}

/** Explicitly reveal the selected experiment's name editor when a scenario needs it. */
export async function developmentRename(page: Page) {
  if (!await page.getByLabel("Experiment name", { exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Rename", exact: true }).click();
  }
}
