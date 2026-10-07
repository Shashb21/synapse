/** Browser proof for owner permissions, selected-workspace reporting and immutable candidate creation. */
import postgres from "postgres";
import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";

const ws = freshWorkspace({ name: "decision-learning" });
test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  const db = postgres(process.env.DATABASE_URL!, {max:1});
  try {
    // Keep immutable cohort/history evidence inside the disposable database, with sharing off.
    await db`update workspaces set learning_sharing_eligible=false where id=${ws.id}`;
    const [row] = await db`select learning_sharing_eligible from workspaces where id=${ws.id}`;
    if (row) expect(row.learning_sharing_eligible).toBe(false);
  } finally { await db.end(); }
});

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
  const report = await (await context.request.get("/api/admin/learning")).json();
  const revision = report.revisions[0];
  await page.locator("summary").filter({hasText:revision.id}).click();
  await page.getByRole("button",{name:`Evaluate ${revision.id}`,exact:true}).click();
  await expect(page.getByLabel(`Evaluation ${revision.id}`)).toContainText("Not eligible for approval");
  await expect(page.getByLabel(`Evaluation ${revision.id}`)).toContainText("Nonempty replay evidence");
  await expect(page.getByRole("button",{name:`Approve ${revision.id}`,exact:true})).toBeDisabled();
  const evaluated = await (await context.request.get("/api/admin/learning")).json();
  const stale = await context.request.post("/api/admin/learning",{data:{action:"approve",revision_id:revision.id,evaluation_id:evaluated.evaluations[0].id,expected_active_id:"prv_stale"}});
  expect(stale.status()).toBe(400);
  // Seed a prior approval as browser fixture evidence; stub evaluation itself cannot approve.
  const seed = postgres(process.env.DATABASE_URL!,{max:1});
  try {
    await seed`insert into prompt_active_revisions(workspace_id,stage,revision_id,generation) values(${ws.id},'S2',${revision.id},1)`;
    await seed`update prompt_revisions set state='active' where id=${revision.id}`;
    await seed`insert into prompt_revision_history(id,workspace_id,stage,before_id,after_id,actor,action,created_at,generation) values(${`prh_browser_${ws.id}`},${ws.id},'S2',null,${revision.id},' {"name":"Browser fixture","function":"medical_affairs"}'::jsonb,'approve','2026-10-07T12:00:00Z',1)`;
    const before = await context.request.post("/api/modules",{data:{stage:"S2",input:{dry_run:true}}});
    expect(before.ok()).toBe(true);
    const beforeRun = await before.json();
    const [workspace] = await seed`select schema_name from workspaces where id=${ws.id}`;
    const [activeRun] = await seed`select workspace_id,steps from ${seed(workspace.schema_name)}.module_runs where id=${beforeRun.run_id}`;
    expect(activeRun.workspace_id).toBe(ws.id);
    expect(activeRun.steps.find((step:{name:string})=>step.name==='prompt:variant').data.version).toBe(revision.id);
    await page.reload();await page.locator("summary").filter({hasText:revision.id}).click();
    await page.getByRole("button",{name:`Roll back ${revision.id}`,exact:true}).click();
    await expect(page.getByRole("table",{name:"Prompt revision history"}).getByRole("row").filter({hasText:revision.id})).toContainText("superseded");
    await expect(page.getByLabel("Prompt activation history")).toContainText("S2 · rollback");
    const after = await context.request.post("/api/modules",{data:{stage:"S2",input:{dry_run:true}}});expect(after.ok()).toBe(true);
    const afterRun = await after.json();
    const [restoredRun] = await seed`select steps from ${seed(workspace.schema_name)}.module_runs where id=${afterRun.run_id}`;
    expect(restoredRun.steps.find((step:{name:string})=>step.name==='prompt:variant').data.version).toBe('v1.0-baseline');
  } finally {await seed.end();}
  await page.getByLabel("Group by").selectOption("week");
  await expect(page.getByLabel("Group by")).toHaveValue("week");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Create S2 candidate" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/private/tmp/task3-learning-mobile.png", fullPage: true });

  const customer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await customer.addCookies([{ name: "synapse_test_as", value: "customer", url: new URL(page.url()).origin }]);
  expect((await customer.request.get(`${new URL(page.url()).origin}/api/admin/learning`)).status()).toBe(403);
  expect((await customer.request.post(`${new URL(page.url()).origin}/api/admin/learning`, { data: { action: "propose", stage: "S2" } })).status()).toBe(403);
  for (const action of ['evaluate','approve','rollback']) expect((await customer.request.post(`${new URL(page.url()).origin}/api/admin/learning`,{data:{action,revision_id:revision.id}})).status()).toBe(403);
  await customer.close();
});
