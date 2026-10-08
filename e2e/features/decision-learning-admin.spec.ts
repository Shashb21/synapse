/** Browser proof for owner permissions, selected-workspace reporting and immutable candidate creation. */
import postgres from "postgres";
import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { CANDIDATE_INSTRUCTION, startLearningBrowserServer } from "../support/learning-provider";
import type { LearningReport } from "../../src/components/platform/learning-console";

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

test("supported S8 candidate earns owner approval and rollback restores baseline instructions", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext();
  const db = postgres(process.env.DATABASE_URL!, { max: 1 });
  let fixture: Awaited<ReturnType<typeof startLearningBrowserServer>> | undefined;
  let workspaceId: string | undefined;
  let accountId: string | undefined;
  try {
    // Bootstrap a disposable staff account through the ordinary admin API.
    // Demo sign-in cannot grant operator, so the non-stub server uses genuine
    // password authentication and the normal operator owner gate.
    const login = await owner.request.post(`${baseURL}/api/auth/login`, { data: { demo: true, actor_name: "Learning Fixture Bootstrap", actor_function: "medical_affairs" } });
    expect(login.ok(), await login.text()).toBe(true);
    const accountEmail = `learning.owner.${Date.now()}@example.test`;
    const accountResponse = await owner.request.post(`${baseURL}/api/admin/users`, { data: { action: "create", email: accountEmail, name: "Learning Browser Owner", actor_function: "medical_affairs", role: "operator" } });
    expect(accountResponse.ok(), "Create disposable operator account").toBe(true);
    const account = await accountResponse.json();
    accountId = account.user.id as string;
    fixture = await startLearningBrowserServer(Number(new URL(baseURL!).port) + 1);
    const url = fixture.url;
    async function post(path: string, data: Record<string, unknown>) {
      const response = await owner.request.post(`${url}${path}`, { data });
      expect(response.ok(), `${path}: ${response.status()} ${await response.text()}\n${fixture!.logs()}`).toBe(true);
      return response.json();
    }
    await post("/api/auth/password/login", { email: accountEmail, password: account.temporary_password });
    const createdWorkspace = await post("/api/workspaces", { name: `E2E supported learning ${Date.now()}`, ai: true });
    workspaceId = createdWorkspace.workspace.id as string;
    await post("/api/admin/workspace", { workspace_id: workspaceId });
    expect((await owner.request.get(`${url}/api/admin/learning`)).ok()).toBe(true);
    const [workspace] = await db`select schema_name from workspaces where id=${workspaceId}`;
    await db`insert into ${db(workspace.schema_name)}.assets(id,name,inn,indication,geography) values('asset','Learningbrand','','','') on conflict(id) do update set name=excluded.name`;

    // Arrange: four training subjects, one gold-only subject, then one replay
    // subject. Each has its own real originating S8 run. Creating replay last
    // means it cannot appear in the earlier frozen gold facts.
    const ids: string[] = [];
    const decisions: string[] = [];
    for (let i = 0; i < 6; i++) {
      await post("/api/iegp", { action: "create_gap", name: `Evidence question ${i}`, statement: `Missing comparative evidence for question ${i}.`, domain: "efficacy" });
      const [gap] = await db`select id from ${db(workspace.schema_name)}.gaps where name=${`Evidence question ${i}`}`;
      ids.push(gap.id);
      await post("/api/iegp", { action: "validate_gap", gap_id: gap.id });
      const run = await post("/api/modules", { stage: "S8", input: { gap_ids: [gap.id], x_axis: "decision_impact", y_axis: "time_pressure", dry_run: true } });
      expect(run.output.placements).toHaveLength(1);
      const [snapshot] = await db`select snapshot from prompt_replay_snapshots where run_id=${run.run_id} and workspace_id=${workspaceId}`;
      expect(snapshot.snapshot.input.gap_ids).toEqual([gap.id]);
      const decisionId = `browser-s8-${workspaceId}-${i}`;
      decisions.push(decisionId);
      await db`insert into decision_examples(id,workspace_id,stage,kind,subject_id,run_id,ai_input,ai_output,outcome,final,lesson,lesson_status,replay_input,replay_exclusion_reason,created_at)
        values(${decisionId},${workspaceId},'S8','s8_band',${gap.id},${run.run_id},'{}'::jsonb,${db.json({ band: run.output.placements[0].suggested_band })},'edited','{"band":"defer"}'::jsonb,
        ${i < 4 ? "Reviewers separate timing from importance." : `Withheld question ${i} lesson.`},'ok',${db.json(snapshot.snapshot)},
        ${i === 4 ? "Gold-only fixture: deliberately excluded from replay." : null},${`2026-01-0${i + 1}T12:00:00Z`})`;
    }
    async function report(): Promise<LearningReport> {
      const response = await owner.request.get(`${url}/api/admin/learning`);
      expect(response.ok()).toBe(true);
      return response.json();
    }
    const page = await owner.newPage();
    await page.goto(`${url}/admin/learning`);
    await expect(page.getByRole("heading", { name: "Decision learning", level: 1 })).toBeVisible();
    await page.getByLabel("Stage", { exact: true }).selectOption("S8");
    await page.getByRole("button", { name: "Create S8 candidate", exact: true }).click();
    await expect(page.getByTestId("learning-created")).toContainText("active prompt is unchanged");
    const proposed = await report();
    const revision = proposed.revisions[0];
    expect(revision.instruction_text).toBe(CANDIDATE_INSTRUCTION);
    expect(proposed.history).toEqual([]);
    const [saved] = await db`select * from prompt_revisions where id=${revision.id} and workspace_id=${workspaceId}`;
    const [cohort] = await db`select * from prompt_revision_cohorts where id=${saved.cohort_id}`;
    expect(saved.training_ids).toEqual(decisions.slice(0, 4));
    expect(saved.heldout_ids).toEqual(decisions.slice(4));
    expect(cohort.gold_reservation.cases, cohort.gold_reservation.reason ?? "Expected reserved held-out gold case").toHaveLength(1);
    expect(cohort.gold_reservation.cases[0].snapshot.input.gap_ids).toEqual([ids[4]]);
    expect(cohort.gold_reservation.cases[0].snapshot.facts.state.gaps.map((gap: { id: string }) => gap.id)).toEqual([ids[4]]);
    const generation = fixture.calls.filter(call => call.purpose === "prompt-revision");
    expect(generation).toHaveLength(1);
    expect(generation[0].user).toContain("Reviewers separate timing from importance.");
    expect(generation[0].user).not.toMatch(/Withheld|Evidence question|defer|browser-s8-/);

    // Act: the browser evaluates both frozen arms, then explicitly approves.
    await page.locator("summary").filter({ hasText: revision.id }).click();
    await page.getByRole("button", { name: `Evaluate ${revision.id}`, exact: true }).click();
    await expect(page.getByLabel(`Evaluation ${revision.id}`)).toContainText("Eligible for explicit approval");
    const evaluated = await report();
    const evaluation = evaluated.evaluations![0];
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.failures).toEqual([]);
    expect(evaluation.baseline_revision_id).toBeNull();
    expect(evaluation.replay_ids).toEqual([decisions[5]]);
    expect(evaluation.baseline.gold_count).toBe(1);
    expect(evaluation.candidate.gold_count).toBe(1);
    expect(evaluation.baseline.replay_count).toBe(1);
    expect(evaluation.candidate.replay_count).toBe(1);
    expect(evaluation.candidate.combined).toBeGreaterThan(evaluation.baseline.combined);
    for (const metric of evaluation.baseline.gold) expect(evaluation.candidate.gold.find(candidate => candidate.name === metric.name)!.value).toBeGreaterThanOrEqual(metric.value);
    expect(evaluation.allowed_example_ids.some(id => saved.excluded_ids.includes(id))).toBe(false);
    expect(evaluated.history).toEqual([]);
    const pointerBefore = await db`select revision_id from prompt_active_revisions where workspace_id=${workspaceId} and stage='S8'`;
    expect(pointerBefore.every(pointer => pointer.revision_id === null)).toBe(true);
    await expect(page.getByRole("button", { name: `Approve ${revision.id}`, exact: true })).toBeEnabled();
    await page.getByRole("button", { name: `Approve ${revision.id}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Roll back ${revision.id}`, exact: true })).toBeVisible();

    // Assert: approval records the authenticated actor and baseline -> candidate;
    // subsequent ordinary stage calls actually receive the approved instructions.
    const approved = await report();
    expect(approved.history).toHaveLength(1);
    expect(approved.history![0]).toMatchObject({ stage: "S8", action: "approve", before_id: null, after_id: revision.id, actor: { name: "Learning Browser Owner", function: "medical_affairs" } });
    await expect(page.getByLabel("Prompt activation history")).toContainText(`S8 · approve · baseline → ${revision.id} · Learning Browser Owner`);
    const [approval] = await db`select evaluation_id,generation from prompt_revision_history where workspace_id=${workspaceId} and action='approve'`;
    expect(approval).toMatchObject({ evaluation_id: evaluation.id, generation: 1 });
    fixture.calls.length = 0;
    const live = await post("/api/modules", { stage: "S8", input: { gap_ids: [ids[0]], dry_run: true } });
    expect(fixture.calls.length).toBeGreaterThan(0);
    expect(fixture.calls.every(call => call.system.includes(CANDIDATE_INSTRUCTION))).toBe(true);
    const [activeRun] = await db`select steps from ${db(workspace.schema_name)}.module_runs where id=${live.run_id}`;
    expect(activeRun.steps.find((step: { name: string }) => step.name === "prompt:variant").data.version).toBe(revision.id);
    const stale = await owner.request.post(`${url}/api/admin/learning`, { data: { action: "approve", revision_id: revision.id, evaluation_id: evaluation.id, expected_active_id: null } });
    expect(stale.status()).toBe(400);
    expect((await stale.json()).error).toMatch(/changed/i);
    expect((await report()).history).toHaveLength(1);
    await page.getByRole("button", { name: `Roll back ${revision.id}`, exact: true }).click();
    await expect(page.getByLabel("Prompt activation history")).toContainText(`S8 · rollback · ${revision.id} → baseline · Learning Browser Owner`);
    const restored = await report();
    expect(restored.history).toHaveLength(2);
    expect(restored.history!.find(item => item.action === "rollback")).toMatchObject({ before_id: revision.id, after_id: null, actor: { name: "Learning Browser Owner", function: "medical_affairs" } });
    expect(restored.revisions[0].state).toBe("superseded");
    const [pointer] = await db`select revision_id,generation from prompt_active_revisions where workspace_id=${workspaceId} and stage='S8'`;
    expect(pointer).toEqual({ revision_id: null, generation: 2 });
    fixture.calls.length = 0;
    const baseline = await post("/api/modules", { stage: "S8", input: { gap_ids: [ids[0]], dry_run: true } });
    expect(fixture.calls.length).toBeGreaterThan(0);
    expect(fixture.calls.every(call => !call.system.includes(CANDIDATE_INSTRUCTION))).toBe(true);
    const [baselineRun] = await db`select steps from ${db(workspace.schema_name)}.module_runs where id=${baseline.run_id}`;
    expect(baselineRun.steps.find((step: { name: string }) => step.name === "prompt:variant").data.version).toBe("v1.0-baseline");
    await page.screenshot({ path: testInfo.outputPath("kan80-supported-approval-rollback.png"), fullPage: true });
  } finally {
    try {
      if (workspaceId) await db`update workspaces set learning_sharing_eligible=false where id=${workspaceId}`;
      if (accountId) {
        await db`update user_accounts set disabled=true where id=${accountId}`;
        await db`delete from auth_sessions where provider_id='password' and subject=${accountId}`;
      }
    } finally {
      try { await db.end(); } finally {
        try { await owner.close(); } finally { await fixture?.close(); }
      }
    }
  }
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
  await page.screenshot({ path: test.info().outputPath("task3-learning-mobile.png"), fullPage: true });

  const customer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await customer.addCookies([{ name: "synapse_test_as", value: "customer", url: new URL(page.url()).origin }]);
  expect((await customer.request.get(`${new URL(page.url()).origin}/api/admin/learning`)).status()).toBe(403);
  expect((await customer.request.post(`${new URL(page.url()).origin}/api/admin/learning`, { data: { action: "propose", stage: "S2" } })).status()).toBe(403);
  for (const action of ['evaluate','approve','rollback']) expect((await customer.request.post(`${new URL(page.url()).origin}/api/admin/learning`,{data:{action,revision_id:revision.id}})).status()).toBe(403);
  await customer.close();
});
