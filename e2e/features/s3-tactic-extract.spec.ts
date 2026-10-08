import postgres from "postgres";
import {createHash} from "node:crypto";
import {freshWorkspace} from "../support/session";
import {iegpAction} from "../support/synapse";
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)])) : value;
import { expect, test } from "@playwright/test";
import {
  clickRunStage,
  evalValue,
  expectRouteIsHonest,
  expectThreeExchanges,
  runRecord,
  runStage,
  seedParsed,
} from "../support/synapse";
import { openInventoryRow } from "../support/inventory";

type TacticExtractOutput = {
  proposed: number;
  accepted: { id: string; name: string; type: string; status: string; source_quote: string; duplicate_of: string | null }[];
  rejected: { id: string; critic_note: string }[];
  committed_tactic_ids: string[];
};

test.describe.configure({ mode: "serial" });

test.describe("S3 tactic extraction", () => {
  test.beforeAll(async ({ request }) => {
    await seedParsed(request);
    await runStage(request, "S2");
  });

  test("extracts the tactics the sources already describe", async ({ page, request }) => {
    const run = await clickRunStage(page, request, "S3");
    expect(run.summary).toMatch(/tactic candidates? accepted/);
    expectRouteIsHonest(run);
  });

  test("debates three proposer↔critic exchanges before the judge", async ({ request }) => {
    const result = await runStage<TacticExtractOutput>(request, "S3", { dry_run: true });
    const { rounds } = await expectThreeExchanges(request, result.run_id);
    expect(rounds).toHaveLength(3);
    expect(evalValue(result, "exchanges")).toBe(3);
  });

  test("puts real inventory in the library, with its status and quote", async ({ page, request }) => {
    const dry = await runStage<TacticExtractOutput>(request, "S3", { dry_run: true });
    // Everything from the first pass is already committed, so a dry re-run finds no
    // new candidate; the library is what proves the commit.
    expect(dry.output.proposed).toBeGreaterThan(0);

    await page.goto("/?place=gaps");
    await openInventoryRow(page);
    const dialog = page.getByRole("dialog");
    // Retry until the page has hydrated; a click before that does nothing.
    await expect(async () => {
      await page.getByRole("button", { name: /map existing tactic/i }).first().click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(dialog.getByRole("combobox").first()).toBeVisible();
    const options = await dialog.getByRole("combobox").first().locator("option").allTextContents();
    expect(options.join(" ").length, "the library should offer extracted tactics").toBeGreaterThan(0);
  });

  test("does not add a tactic the judge marks as already in the library", async ({ request }) => {
    const again = await runStage<TacticExtractOutput>(request, "S3");
    expect(again.output.committed_tactic_ids).toHaveLength(0);

    // The judge names the library tactic each repeat is the same as; commit skips
    // those. The judge step is in the trace.
    expect(again.output.accepted.length).toBeGreaterThan(0);
    expect(again.output.accepted.some((row) => Boolean(row.duplicate_of))).toBeTruthy();
    const run = await runRecord(request, again.run_id);
    expect(run.steps.some((step) => step.name === "judge:model")).toBeTruthy();
  });

  test("scores itself against its gold cases", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S3", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { cases: number; metrics: { name: string }[] };
    expect(body.cases).toBeGreaterThan(0);
    expect(body.metrics.map((metric) => metric.name)).toContain("real_inventory_share");
  });
});

/** Source-review fixtures exercise real authenticated API decisions, with no live model claim. */
test.describe("S3 overlap source review", () => {
  const ws = freshWorkspace({name: "S3 source review", seed: async request => {
    await seedParsed(request);
    await iegpAction(request, {action: "create_gap", domain: "safety", name: "Source expansion gap", statement: "Subgroup evidence needed", rationale: "Browser fixture"});
    await iegpAction(request, {action: "record_missed_tactic", name: "Reviewed parent registry", type: "registry", status: "ongoing", evidence_question: "Original parent scope", rationale: "Locked source parent"});
  }});
  test("compares current and proposed scope, saves edits and gap, and records expand/separate/reject outcomes", async ({page, request}) => {
    test.setTimeout(90_000); page.setDefaultTimeout(10_000);
    const pg = postgres(process.env.DATABASE_URL!);
    try {
      const [workspace] = await pg`select schema_name from workspaces where id = ${ws.id}`;
      const schema = workspace!.schema_name as string;
      const [parent] = await pg`select * from ${pg(`${schema}.tactics`)} where name='Reviewed parent registry'`;
      parent!.lock = {locked: true, actor_name: "Feature E2E", actor_function: "medical_affairs", locked_at: "2026-10-07T12:00:00.000Z", note: "Reviewed locked protocol"};
      await pg`update ${pg(`${schema}.tactics`)} set lock=${pg.json(parent!.lock)} where id=${parent!.id}`;
      const [source] = await pg`select * from ${pg(`${schema}.sources`)} limit 1`;
      const [gap] = await pg`select * from ${pg(`${schema}.gaps`)} where name='Source expansion gap'`;
      const version = createHash("sha256").update(JSON.stringify(canonical({...parent, source_quote: parent!.source_quote ?? "", custom_type: parent!.custom_type ?? null}))).digest("hex");
      const scope = {name: "Source subgroup", evidence_question: "Added subgroup question", population: "Subgroup patients", outcomes: "Safety", geography: "", data_cut: "", analysis: "Post-hoc subgroup", instrument: "", study_design: "Retrospective analysis", gap_coverage: "Subgroup evidence", cost_effort: "Two analyst weeks", timing: "Next quarter", feasibility_risks: "Small subgroup", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null};
      for (const id of ["S3-BROWSER-EXPAND", "S3-BROWSER-SEPARATE", "S3-BROWSER-REJECT"]) {
        const separate = {name: `Separate ${id}`, type: "rwe_study", status: "planned", evidence_question: "Independent subgroup question"};
        const payload = {id, version: id, run_id: "browser-source-run", document_id: "browser-document", source_id: source!.id, source_quote: "The source describes a subgroup analysis.", target_tactic_id: parent!.id, expected_tactic_version: version, reviewed_parent: parent, shared_scope: "Existing registry population", new_scope: "Added subgroup population", expansion: scope, original_expansion: scope, separate, original_separate: separate, gap_id: null, status: "pending", result_expansion_id: null, result_tactic_id: null, history: [], created_at: "2026-10-07T12:00:00.000Z", updated_at: "2026-10-07T12:00:00.000Z"};
        await pg`insert into ${pg(`${schema}.tactic_suggestions`)} ${pg({id, source_key: id, target_tactic_id: parent!.id, source_id: source!.id, status: "pending", payload: pg.json(payload), created_at: payload.created_at, updated_at: payload.updated_at})}`;
      }
      await page.goto("/tactics");
      const region = page.getByRole("region", {name: "Source tactic reviews"});
      const expand = region.locator("article").filter({hasText: "S3-BROWSER-EXPAND"});
      await expect(expand.getByText("Original parent scope", {exact: true})).toBeVisible();
      await expect(expand.locator("p").filter({hasText: /^Added subgroup question$/})).toBeVisible();
      await expand.getByRole("button", {name: "Edit expansion scope"}).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", {name: "Name", exact: true}).fill("Human-reviewed subgroup");
      await dialog.getByRole("combobox", {name: "Gap to cover"}).selectOption(gap!.id as string);
      await dialog.getByLabel("Rationale (required)").fill("Scope checked against source and selected gap");
      await dialog.getByRole("button", {name: "Save review edits", exact: true}).click();
      await expect(dialog).toBeHidden();
      await expand.getByRole("button", {name: "Accept expansion"}).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("button", {name: "Accept expansion", exact: true}).click();
      await expect(dialog.getByText(/short rationale is required/)).toBeVisible();
      await dialog.getByLabel("Rationale (required)").fill("Feasible added source scope");
      const response = page.waitForResponse(r => r.url().includes("/api/plan") && r.request().method() === "POST");
      await dialog.getByRole("button", {name: "Accept expansion", exact: true}).click();
      expect((await response).status()).toBe(200); await expect(dialog).toBeHidden();
      await expect(expand.getByText("expanded", {exact: true})).toBeVisible();
      for (const [id, label, rationale] of [["S3-BROWSER-SEPARATE", "Accept separate tactic", "Independent source activity"], ["S3-BROWSER-REJECT", "Reject suggestion", "Source addition unsupported"]]) {
        const item = region.locator("article").filter({hasText: id!});
        await item.getByRole("button", {name: label!}).click(); dialog = page.getByRole("dialog");
        await dialog.getByLabel("Rationale (required)").fill(rationale!);
        await dialog.getByRole("button", {name: label!, exact: true}).click(); await expect(dialog).toBeHidden();
      }
      const rows = await pg`select payload from ${pg(`${schema}.tactic_suggestions`)} order by id`;
      expect(rows.map(r => (r.payload as {status: string}).status)).toEqual(["expanded", "rejected", "separate"]);
      const [child] = await pg`select * from ${pg(`${schema}.tactic_expansions`)} limit 1`;
      expect(child).toMatchObject({status: "proposed", scope: {name: "Human-reviewed subgroup"}});
      expect(await pg`select * from ${pg(`${schema}.tactics`)} where id=${parent!.id}`).toEqual([parent]);
      const [separateRef] = await pg`select * from ${pg(`${schema}.tactic_source_references`)} limit 1`;
      expect(separateRef).toMatchObject({source_id: source!.id, source_quote: "The source describes a subgroup analysis."});
      await page.setViewportSize({width: 390, height: 844});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({fullPage: true, path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-5-source-review-mobile.png"});
      await page.setViewportSize({width: 1280, height: 900});
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({fullPage: true, path: ".superpowers/sdd/2026-10-07-kan77-kan76-learning-expansions/task-5-source-review-desktop.png"});
    } finally { await pg.end(); }
  });
});
