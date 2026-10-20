import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction } from "../support/synapse";

test.describe("KAN-119 displayed number sort", () => {
  freshWorkspace({ name: "KAN-119" });
  test("ID header orders the visible numbers ascending and descending", async ({ page, request }) => {
    await iegpAction(request, { action: "reset" });
    for (let i = 0; i < 3; i++) {
      await iegpAction(request, { action: "create_gap", statement: `Sorting question ${i}`, domain: "unmet_need" });
    }
    await page.goto("/?place=gaps");
    const rows = page.getByTestId("evidence-inventory").locator("tr[data-gap-id]");
    await expect(rows).toHaveCount(3);
    const header = page.getByRole("columnheader").filter({ has: page.getByRole("button", { name: "Sort by ID", exact: true }) });
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    const labels = () => rows.locator("td:first-child").allTextContents();
    await expect.poll(labels).toEqual(["001", "002", "003"]);
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await expect.poll(labels).toEqual(["003", "002", "001"]);
  });
});
