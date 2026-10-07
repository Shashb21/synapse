/** Browser proof for owner permissions, selected-workspace reporting and immutable candidate creation. */
import postgres from "postgres";
import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";

const ws = freshWorkspace({ name: "decision-learning" });
test.describe.configure({ mode: "serial" });

test("owner sees counts and creates a candidate; customers are refused", async ({ page, context, browser }) => {
  const selected = await context.request.post("/api/admin/workspace", { data: { workspace_id: ws.id } });
  expect(selected.ok()).toBe(true);
  // Initialize registered evidence tables, then seed only this isolated fixture workspace.
  expect((await context.request.get("/api/admin/learning")).ok()).toBe(true);
  const db = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse_test", { max: 1 });
  try {
    const [workspace] = await db`select schema_name from workspaces where id = ${ws.id}`;
    await db`insert into ${db(workspace.schema_name)}.assets (id, name, inn, indication, geography) values ('asset', 'Browserbrand', '', '', '') on conflict (id) do update set name = excluded.name`;
    for (let i = 0; i < 4; i++) await db`insert into decision_examples
      (id, workspace_id, stage, kind, subject_id, ai_input, ai_output, outcome, lesson, lesson_status, created_at)
      values (${`browser-${ws.id}-${i}`}, ${ws.id}, 'S2', 'gap_suggestion', ${`subject-${i}`}, '{"text":"Browserbrand private input"}'::jsonb, '{}'::jsonb,
      ${["accepted", "edited", "rejected", "rejected"][i]}, 'Reviewers keep a narrower population separate.', 'ok', '2026-10-05T12:00:00Z')`;
  } finally { await db.end(); }
  await page.goto("/admin/learning");
  await expect(page.getByRole("heading", { name: "Decision learning", level: 1 })).toBeVisible();
  await expect(page.getByTestId("admin-workspace-bar")).toHaveAttribute("data-workspace-id", ws.id);
  await expect(page.getByTestId("learning-summary")).toContainText("4 decisions");
  const table = page.getByRole("table", { name: "S2 agreement counts and shares" });
  await expect(table).toContainText("1 (25.0%)"); await expect(table).toContainText("2 (50.0%)");
  await expect(page.getByRole("img", { name: /S2 agreement chart/ })).toBeVisible();
  await page.getByRole("button", { name: "Create S2 candidate" }).click();
  await expect(page.getByTestId("learning-created")).toContainText("active prompt is unchanged");
  await expect(page.getByRole("table", { name: "Prompt revision history" })).toContainText("candidate");
  await page.getByLabel("Group by").selectOption("week");
  await expect(page.getByLabel("Group by")).toHaveValue("week");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Create S2 candidate" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/private/tmp/task2-learning-mobile.png", fullPage: true });

  const customer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await customer.addCookies([{ name: "synapse_test_as", value: "customer", url: new URL(page.url()).origin }]);
  expect((await customer.request.get(`${new URL(page.url()).origin}/api/admin/learning`)).status()).toBe(403);
  expect((await customer.request.post(`${new URL(page.url()).origin}/api/admin/learning`, { data: { action: "propose", stage: "S2" } })).status()).toBe(403);
  await customer.close();
});
