import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, seedMapped } from "../support/synapse";

const workspace = freshWorkspace({ name: "KAN-117", seed: request => seedMapped(request) });

test("compact source suggestions, affected gap navigation, choices and save states", async ({ page, request }) => {
  const gap = await firstOpenGap(request);
  const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1 });
  try {
    const schema = `ws_${workspace.id}`;
    const [source] = await sql`select id from ${sql(schema)}.sources limit 1`;
    await sql`insert into ${sql(schema)}.gap_suggestions ${sql({
      id: "kan117-suggestion", gap_id: gap.gap_id, run_id: "kan117", source_id: source.id,
      name: "New population", statement: "Evidence for older patients?", domain: "comparative_effectiveness",
      source_quote: "Older patients need evidence.", shared_part: "Comparative evidence", new_part: "Older patients",
      merged_name: "Comparative evidence including older patients", merged_statement: "How effective is it including older patients?",
      split_name: "Older patients", split_statement: "How effective is it in older patients?",
      status: "pending", created_at: new Date().toISOString(),
    })}`;
  } finally { await sql.end(); }
  await page.goto("/?place=gaps");
  const panel = page.getByTestId("gap-suggestions");
  const details = panel.locator("details");
  await expect(details).not.toHaveAttribute("open");
  const summary = panel.locator("summary");
  await summary.focus();
  await summary.press("Enter");
  await expect(details).toHaveAttribute("open");
  await summary.press("Space");
  await expect(details).not.toHaveAttribute("open");
  const affected = page.locator(`tr[data-gap-id="${gap.gap_id}"]`).getByRole("button", { name: "Source suggestions (1)" });
  await affected.focus();
  await affected.press("Enter");
  await expect(panel.locator("li")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const choice of ["Merge into existing gap", "Create separate gap", "Reject suggestion"]) {
    await panel.getByRole("button", { name: new RegExp(`^${choice}`) }).click();
    const dialog = page.getByRole("dialog");
    if (choice.startsWith("Merge")) await expect(dialog).toContainText("validated priority goes back to draft");
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.getByRole("alert")).toContainText("Fill in");
    await dialog.locator('[name="note"]').fill("Reviewed source and consequences");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/iegp", async route => {
      await gate;
      await route.fulfill({ status: 500, json: { safe_error: true, request_outcome: "rejected", error: "Suggestion save failed" } });
    });
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
    release();
    await expect(dialog.getByRole("alert")).toHaveText("Suggestion save failed");
    await expect(dialog.locator('[name="note"]')).toHaveValue("Reviewed source and consequences");
    await page.unroute("**/api/iegp");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
});
