import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, seedMapped } from "../support/synapse";

test.describe("KAN-115 next action", () => {
  freshWorkspace({ name: "KAN-115", seed: (request) => seedMapped(request) });
  test.setTimeout(90_000);

  test("mouse and keyboard toggle the next task; status errors are associated and preserve input", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    await page.goto("/?place=gaps");
    const row = page.locator(`tr[data-gap-id="${gap.gap_id}"]`);
    const next = row.locator("[data-next-action] button");
    await expect(next).toBeVisible();
    const details = page.getByRole("region", { name: "Outstanding gap review" });
    await expect(next).toHaveAttribute("aria-expanded", "false");
    await expect(details).toHaveCount(0);
    for (const activation of ["mouse", "Enter", "Space"] as const) {
      // Each native activation opens, closes, and reopens the same review task.
      for (const expanded of [true, false, true, false]) {
        if (activation === "mouse") await next.click();
        else {
          await next.focus();
          await next.press(activation);
        }
        await expect(next).toHaveAttribute("aria-expanded", String(expanded));
        if (expanded) {
          await expect(details).toBeVisible();
          await expect(details.locator("button:focus, a:focus, [tabindex='-1']:focus")).toHaveCount(1);
        } else {
          await expect(details).toHaveCount(0);
          await expect(next).toBeFocused();
        }
      }
    }

    // The mapped demo has multiple actionable gaps; switching keeps one review open.
    const other = page.locator(`tr[data-gap-id]:not([data-gap-id="${gap.gap_id}"]) [data-next-action] button`).first();
    await next.click();
    await other.click();
    await expect(next).toHaveAttribute("aria-expanded", "false");
    await expect(other).toHaveAttribute("aria-expanded", "true");
    await expect(details).toHaveCount(1);
    await expect(details.locator("button:focus, a:focus, [tabindex='-1']:focus")).toHaveCount(1);
    await next.click();
    await expect(next).toHaveAttribute("aria-expanded", "true");
    await expect(other).toHaveAttribute("aria-expanded", "false");
    await expect(details).toHaveCount(1);
    await expect(details.locator("button:focus, a:focus, [tabindex='-1']:focus")).toHaveCount(1);
    await page.goto(`/gaps/${gap.gap_id}`);
    await page.getByRole("button", { name: /Change status of this gap/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Save override" }).click();
    const reason = dialog.getByRole("textbox", { name: "Reason" });
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    const reasonError = dialog.getByRole("alert");
    await expect(reasonError).toHaveText("A reason is required to override computed gap status.");
    await expect(reason).toHaveAttribute("aria-describedby", await reasonError.getAttribute("id") as string);
    await reason.fill("Keep this assessment for review");
    await dialog.getByRole("combobox").selectOption("validated_addressed");
    await page.route("**/api/iegp", async route => {
      if (route.request().postDataJSON()?.action === "override_gap_status") {
        await route.fulfill({ status: 500, json: { error: "Status save failed" } });
      } else await route.continue();
    });
    await dialog.getByRole("button", { name: "Save override" }).click();
    const saveError = dialog.getByRole("alert");
    await expect(saveError).toHaveText("Status save failed");
    await expect(dialog.getByRole("combobox")).toHaveAttribute("aria-describedby", await saveError.getAttribute("id") as string);
    await expect(reason).toHaveValue("Keep this assessment for review");
    await expect(dialog.getByRole("combobox")).toHaveValue("validated_addressed");
  });
});
