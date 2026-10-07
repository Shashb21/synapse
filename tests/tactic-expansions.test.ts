import { beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import "@/modules";
import * as tables from "@/lib/iegp/schema";
import { db } from "@/lib/iegp/db";
import { buildSeed } from "@/lib/iegp/seed";
import { assignTacticToGap, loadState, persistState, rejectMapping, lockCoverageOverall, lockCoverageDimension, saveMappingTableRow, splitPartialGap, rewritePartialGap, syncComputedGapStatuses } from "@/lib/iegp/store";
import { acceptTacticExpansion, setExpansionStatus, tacticVersion } from "@/lib/iegp/tactic-expansions";
import { runInWorkspace } from "@/modules/workspaces/context";
import { POST } from "@/app/api/plan/route";
import { kgMappingModule } from "@/modules/stages/s4-kg-mapping/module";
import type { ModuleContext } from "@/modules/kernel/contracts";
import { computeGapStatus, unlocked, countingCoverages } from "@/lib/iegp/engine";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import type { ExpansionScope } from "@/lib/iegp/types";

const actor = { name: "A. Rao", function: "heor" as const };
const scope: ExpansionScope = {
  name: "Community post-hoc analysis", evidence_question: "ILD rates in community clinics?", population: "community patients",
  outcomes: "ILD", geography: "US", data_cut: "2026", analysis: "post-hoc subgroup analysis", instrument: "",
  study_design: "Retrospective analysis", gap_coverage: "Community ILD rates", cost_effort: "Two analyst weeks",
  timing: "2026 Q4", feasibility_risks: "Small subgroup", post_hoc: true, prospective_enrolment: false,
  protocol_amendment: false, start_date: "2026-10-08", evidence_available: "2026-12-01",
};
let args: Parameters<typeof acceptTacticExpansion>[0];

beforeEach(async () => {
  const state = buildSeed();
  state.tactics[0]!.status = "ongoing";
  await persistState(state);
  args = { proposal_id: "s9:proposal-1", tactic_id: state.tactics[0]!.id, gap_id: state.gaps[0]!.id, scope,
    rationale: "Added scope is feasible without changing the parent", actor, expected_tactic_version: tacticVersion(state.tactics[0]!) };
});

describe("canonical expansion acceptance", () => {
  it("rolls back inherited associations, gaps, coverage and audits when scoped split insertion fails", async () => {
    const child = await acceptTacticExpansion(args);
    await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Funded child", actor, expected_version: child.version});
    const before = await loadState();
    await db().execute(sql.raw(`CREATE FUNCTION reject_split_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.expansion_id IS NOT NULL AND NEW.gap_id <> '${args.gap_id}' THEN RAISE EXCEPTION 'injected scoped split failure'; END IF; RETURN NEW; END $$`));
    await db().execute(sql`CREATE TRIGGER reject_split_scope BEFORE INSERT ON coverages FOR EACH ROW EXECUTE FUNCTION reject_split_scope()`);
    try {
      await expect(splitPartialGap({parent_gap_id: args.gap_id, addressed_name: "Covered scope", open_name: "Uncovered scope", tactic_ids: [child.id], actor_name: actor.name, actor_function: actor.function})).rejects.toMatchObject({cause: {message: "injected scoped split failure"}});
      expect(await loadState()).toEqual(before);
    } finally {
      await db().execute(sql`DROP TRIGGER reject_split_scope ON coverages`);
      await db().execute(sql`DROP FUNCTION reject_split_scope()`);
    }
  });
  it("cold migration upgrades isolated legacy parent tables without changing IDs, counts or locks", async () => {
    const pg = postgres(process.env.DATABASE_URL!);
    const schema = `ws_legacy_${crypto.randomUUID().replaceAll("-", "")}`;
    const state = buildSeed();
    const tactic = state.tactics[0]!, coverage = state.coverages.find(c => c.tactic_id === tactic.id)!;
    try {
      await pg.unsafe(`CREATE SCHEMA "${schema}"`);
      // Asset structure is unaffected by expansion migration. Parent/coverage tables are explicit legacy DDL.
      await pg.unsafe(`CREATE TABLE "${schema}".assets (LIKE public.assets INCLUDING DEFAULTS)`);
      await pg.unsafe(`CREATE TABLE "${schema}".tactics (
        id text PRIMARY KEY, name text NOT NULL, type text NOT NULL, description text NOT NULL, evidence_question text NOT NULL,
        population text NOT NULL, intervention text NOT NULL, comparator text NOT NULL, outcomes text NOT NULL, geography text NOT NULL,
        data_source text NOT NULL, study_design text NOT NULL, lifecycle_stage text NOT NULL, status text NOT NULL,
        review_status text NOT NULL DEFAULT 'accepted', start_date text, evidence_available text, owner text NOT NULL,
        function text NOT NULL, budget text, intended_use text NOT NULL, lock jsonb NOT NULL)`);
      await pg.unsafe(`CREATE TABLE "${schema}".coverages (
        id text PRIMARY KEY, gap_id text NOT NULL, tactic_id text NOT NULL, dimensions jsonb NOT NULL,
        overall text NOT NULL, overall_rationale text NOT NULL, overall_lock jsonb NOT NULL, stale boolean NOT NULL DEFAULT false)`);
      await pg.unsafe(`INSERT INTO "${schema}".assets SELECT * FROM jsonb_populate_record(NULL::"${schema}".assets, $1::jsonb)`, [pg.json(JSON.parse(JSON.stringify(state.asset)))]);
      await pg.unsafe(`INSERT INTO "${schema}".tactics SELECT * FROM jsonb_populate_record(NULL::"${schema}".tactics, $1::jsonb)`, [pg.json(tactic)]);
      await pg.unsafe(`INSERT INTO "${schema}".coverages SELECT * FROM jsonb_populate_record(NULL::"${schema}".coverages, $1::jsonb)`, [pg.json(coverage)]);
      expect((await pg`select to_regclass(${`${schema}.tactic_expansions`}) as name`)[0]!.name).toBeNull();
      expect(await pg`select column_name from information_schema.columns where table_schema=${schema} and table_name='coverages' and column_name='expansion_id'`).toHaveLength(0);
      await runInWorkspace({workspace_id: schema, schema}, async () => {
        const migrated = await loadState();
        expect(migrated.expansions).toEqual([]);
        expect(migrated.tactics).toHaveLength(1);
        expect(migrated.tactics[0]).toMatchObject({id: tactic.id, name: tactic.name, status: tactic.status, evidence_question: tactic.evidence_question, lock: tactic.lock});
        expect(migrated.coverages).toHaveLength(1);
        expect(migrated.coverages[0]).toMatchObject({...coverage, expansion_id: null});
      });
    } finally {
      await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pg.end();
    }
  });
  it("split retains addressed and residual child identities, locks and cancellation eligibility", async () => {
    const child = await acceptTacticExpansion(args);
    const sibling = await acceptTacticExpansion({...args, proposal_id: "s9:sibling", scope: {...scope, name: "Sibling scope"}});
    const planned = await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Funded child", actor, expected_version: child.version});
    await lockCoverageDimension({coverage_id: (await loadState()).coverages.find(c => c.expansion_id === child.id)!.id, dimension: "population", value: "yes", rationale: "Scoped population checked", actor_name: actor.name, actor_function: actor.function});
    const before = await loadState();
    const source = before.coverages.find(c => c.expansion_id === child.id)!;
    const result = await splitPartialGap({parent_gap_id: args.gap_id, addressed_name: "Community evidence covered", open_name: "Comparator still missing", tactic_ids: [child.id], open_tactic_ids: [sibling.id], actor_name: actor.name, actor_function: actor.function});
    const after = await loadState();
    const addressed = after.coverages.filter(c => c.gap_id === result.addressedId);
    expect(addressed).toHaveLength(1);
    expect(addressed[0]).toMatchObject({tactic_id: args.tactic_id, expansion_id: child.id, overall: "full", overall_lock: {locked: true}, dimensions: source.dimensions});
    expect(after.coverages.find(c => c.gap_id === result.openId)).toMatchObject({tactic_id: args.tactic_id, expansion_id: sibling.id, overall: "unassessed"});
    const inherited = after.expansions.find(e => e.id === child.id)!;
    expect(inherited.gap_ids).toContain(result.addressedId);
    expect(inherited.version).not.toBe(planned.version);
    expect(inherited.scope).toEqual(child.scope);
    expect(after.audit.some(a => a.entity_id === child.id && a.detail.includes(source.id) && a.detail.includes(result.addressedId))).toBe(true);
    await expect(setExpansionStatus({expansion_id: child.id, status: "cancelled", rationale: "Cancel child", actor, expected_version: planned.version})).rejects.toThrow(/stale/);
    await setExpansionStatus({expansion_id: child.id, status: "cancelled", rationale: "Cancel child", actor, expected_version: inherited.version});
    const cancelled = await loadState();
    expect(countingCoverages(cancelled.coverages.filter(c => c.gap_id === result.addressedId), cancelled.tactics, cancelled.expansions)).toEqual([]);
    expect(cancelled.gaps.find(g => g.id === result.addressedId)!.computed_status).toBe("validated_open");
    expect(cancelled.coverages.filter(c => c.gap_id === result.addressedId).some(c => !c.expansion_id)).toBe(false);
  });
  it.each(["proposed", "cancelled", "missing"])("refuses %s addressed child before any split writes", async status => {
    const child = await acceptTacticExpansion(args);
    if (status === "cancelled") await setExpansionStatus({expansion_id: child.id, status: "cancelled", rationale: "Cancel child", actor, expected_version: child.version});
    const before = await loadState();
    await expect(splitPartialGap({parent_gap_id: args.gap_id, addressed_name: "Covered slice", open_name: "Unanswered slice", tactic_ids: [status === "missing" ? "EXP-MISSING" : child.id], actor_name: actor.name, actor_function: actor.function})).rejects.toThrow();
    expect(await loadState()).toEqual(before);
  });
  it("preserves independently selected parent and child Full evidence on the same addressed gap", async () => {
    const child = await acceptTacticExpansion(args);
    await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Child funded", actor, expected_version: child.version});
    const result = await splitPartialGap({parent_gap_id: args.gap_id, addressed_name: "Parent and added scope covered", open_name: "Uncovered comparator", tactic_ids: [args.tactic_id, child.id], actor_name: actor.name, actor_function: actor.function});
    const after = await loadState();
    const inherited = after.coverages.filter(c => c.gap_id === result.addressedId);
    expect(inherited).toHaveLength(2);
    expect(new Set(inherited.map(c => c.expansion_id ?? "parent"))).toEqual(new Set([child.id, "parent"]));
    await setExpansionStatus({expansion_id: child.id, status: "cancelled", rationale: "Cancel child only", actor, expected_version: after.expansions.find(e => e.id === child.id)!.version});
    const cancelled = await loadState();
    expect(countingCoverages(cancelled.coverages.filter(c => c.gap_id === result.addressedId), cancelled.tactics, cancelled.expansions)).toHaveLength(1);
    expect(cancelled.gaps.find(g => g.id === result.addressedId)!.computed_status).toBe("validated_addressed");
  });
  it("rewrite keeps child Full scoped and cancellation recomputes it Open", async () => {
    const child = await acceptTacticExpansion(args);
    await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Child funded", actor, expected_version: child.version});
    const id = await rewritePartialGap({gap_id: args.gap_id, name: "Community addressed", status: "validated_addressed", tactic_ids: [child.id], actor_name: actor.name, actor_function: actor.function});
    const after = await loadState();
    expect(after.coverages.filter(c => c.gap_id === id)).toMatchObject([{expansion_id: child.id, overall: "full"}]);
    await setExpansionStatus({expansion_id: child.id, status: "cancelled", rationale: "Cancel child", actor, expected_version: after.expansions[0]!.version});
    expect((await loadState()).gaps.find(g => g.id === id)!.computed_status).toBe("validated_open");
  });
  it("commits genuine Open-to-Addressed child transition and residual closure in the same transaction", async () => {
    const state = buildSeed();
    state.coverages = [];
    const gap = state.gaps[0]!;
    Object.assign(gap, {status: "validated_open", computed_status: "validated_open", human_validated: false, status_lock: unlocked(), status_override: null});
    state.residual_gap_suggestions = [{parent_gap_id: gap.id, statement: "Candidate leftover", reasons: ["Uncovered scope"], status: "candidate", lock: unlocked()}];
    await persistState(state);
    const child = await acceptTacticExpansion({...args, expected_tactic_version: tacticVersion(state.tactics[0]!)});
    const coverage = (await loadState()).coverages[0]!;
    await lockCoverageOverall({coverage_id: coverage.id, overall: "full", rationale: "Human validates child only", actor_name: actor.name, actor_function: actor.function});
    expect((await loadState()).gaps.find(g => g.id === gap.id)!.computed_status).toBe("validated_open");
    await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Resources committed", actor, expected_version: child.version});
    const after = await loadState();
    expect(after.gaps.find(g => g.id === gap.id)!.computed_status).toBe("validated_addressed");
    expect(after.gaps.find(g => g.id === gap.id)!.status_override).toBeNull();
    expect(after.residual_gap_suggestions[0]).toMatchObject({status: "rejected", lock: {locked: true, note: "Addressed. No residual."}});
    expect(after.expansions[0]!.history).toHaveLength(2);
  });
  it("publishes changed S4 implementation identity for stale evaluation rejection", () => {
    expect(kgMappingModule.manifest.version).toBe("3.2.0");
  });
  it("accepts and changes lifecycle successfully inside a nondefault workspace", async () => {
    await runInWorkspace({workspace_id: "expansion-success", schema: "ws_expansion_success"}, async () => {
      const state = buildSeed();
      await persistState(state);
      const child = await acceptTacticExpansion({...args, expected_tactic_version: tacticVersion(state.tactics[0]!)});
      const planned = await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Separate workspace approved", actor, expected_version: child.version});
      expect((await loadState()).expansions[0]!.status).toBe("planned");
      expect(planned.history).toHaveLength(2);
    });
  });
  it("legacy parent mapping row edits preserve distinct child scopes", async () => {
    const child = await acceptTacticExpansion(args);
    const before = (await loadState()).coverages.find(c => c.expansion_id === child.id)!;
    await saveMappingTableRow({gap_id: args.gap_id, tactic_ids: [], mapping_status: "open", rationale: "Remove base mappings only", actor_name: actor.name, actor_function: actor.function});
    expect((await loadState()).coverages.find(c => c.expansion_id === child.id)).toEqual(before);
  });
  it("human review locks only child coverage; proposed Full stays Open and planned alone never validates Full", async () => {
    const child = await acceptTacticExpansion(args);
    const before = await loadState();
    const coverage = before.coverages.find(c => c.expansion_id === child.id)!;
    await assignTacticToGap({gap_id: args.gap_id, tactic_id: args.tactic_id, expansion_id: child.id,
      coverage: "full", actor_name: "S4", actor_function: "heor"});
    let state = await loadState();
    let row = state.coverages.find(c => c.id === coverage.id)!;
    expect(computeGapStatus([row], state.tactics, {expansions: state.expansions})).toBe("validated_open");
    const planned = await setExpansionStatus({expansion_id: child.id, status: "planned", rationale: "Funding approved", actor, expected_version: child.version});
    state = await loadState(); row = state.coverages.find(c => c.id === coverage.id)!;
    expect(row.overall_lock.locked).toBe(false);
    expect(computeGapStatus([row], state.tactics, {expansions: state.expansions})).toBe("validated_partial");
    await lockCoverageDimension({coverage_id: coverage.id, dimension: "population", value: "yes", rationale: "Community population fits", actor_name: actor.name, actor_function: actor.function});
    await lockCoverageOverall({coverage_id: coverage.id, overall: "full", rationale: "Scoped question fully covered", actor_name: actor.name, actor_function: actor.function});
    state = await loadState(); row = state.coverages.find(c => c.id === coverage.id)!;
    expect(row.overall_lock.locked).toBe(true);
    expect(row.dimensions.population.lock.locked).toBe(true);
    expect(computeGapStatus([row], state.tactics, {expansions: state.expansions})).toBe("validated_addressed");
    await setExpansionStatus({expansion_id: child.id, status: "proposed", rationale: "Resources withdrawn", actor, expected_version: planned.version});
    state = await loadState(); row = state.coverages.find(c => c.id === coverage.id)!;
    expect(computeGapStatus([row], state.tactics, {expansions: state.expansions})).toBe("validated_open");
    expect(state.coverages.filter(c => !c.expansion_id)).toEqual(before.coverages.filter(c => !c.expansion_id));
  });
  it.each(["status", "evidence_question"] as const)("detects an actual changed parent %s rather than an inert version field", async field => {
    const before = await loadState();
    await db().update(tables.tactics).set(field === "status" ? {status: "planned"} : {evidence_question: "Changed design question"}).where(eq(tables.tactics.id, args.tactic_id));
    await expect(acceptTacticExpansion(args)).rejects.toThrow(/changed|stale/i);
    const after = await loadState();
    expect(after.expansions).toEqual([]);
    expect(after.coverages).toEqual(before.coverages);
  });
  it("keeps a human lock acquired after the model read and before its scoped write", async () => {
    const child = await acceptTacticExpansion(args);
    const state = await loadState();
    const coverage = state.coverages.find(c => c.expansion_id === child.id)!;
    const d = db(), originalUpdate = d.update.bind(d);
    let injected = false;
    const spy = vi.spyOn(d, "update").mockImplementation((table) => {
      const builder = originalUpdate(table);
      if (table !== tables.coverages) return builder;
      const wrap = (object: object): object => new Proxy(object, {get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then") return async (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
          if (!injected) {
            injected = true;
            await originalUpdate(tables.coverages).set({overall: "limited", overall_lock: {...coverage.overall_lock, locked: true, actor_name: actor.name}}).where(eq(tables.coverages.id, coverage.id));
          }
          return Reflect.apply(value, target, [resolve, reject]);
        };
        if (["set", "where", "returning"].includes(String(key))) return (...values: unknown[]) => wrap(Reflect.apply(value, target, values));
        return typeof value === "function" ? value.bind(target) : value;
      }});
      return wrap(builder) as typeof builder;
    });
    try {
      await expect(assignTacticToGap({gap_id: args.gap_id, tactic_id: args.tactic_id, expansion_id: child.id,
        actor_name: "S4", actor_function: "heor", coverage: "full"})).rejects.toThrow(/changed|review|locked/i);
      const after = (await loadState()).coverages.find(c => c.id === coverage.id)!;
      expect(after.overall).toBe("limited");
      expect(after.overall_lock.locked).toBe(true);
    } finally { spy.mockRestore(); }
  });
  it("lets source owners compose child acceptance with their decision in one transaction", async () => {
    const before = await loadState();
    await expect(db().transaction(async (tx) => {
      await acceptTacticExpansion(args, tx);
      throw new Error("source decision failed");
    })).rejects.toThrow("source decision failed");
    expect(await loadState()).toEqual(before);
  });
  it("requires an origin and feasible scope without modifying parent protocols", async () => {
    await expect(acceptTacticExpansion({...args, proposal_id: " "})).rejects.toThrow(/origin/i);
    await expect(acceptTacticExpansion({...args, scope: {...scope, post_hoc: false}})).rejects.toThrow(/post.hoc/i);
    const state = await loadState();
    state.tactics[0]!.status = "completed";
    await persistState(state);
    await expect(acceptTacticExpansion({...args, expected_tactic_version: tacticVersion(state.tactics[0]!), scope: {...scope, prospective_enrolment: true}})).rejects.toThrow(/prospective/i);
    expect((await loadState()).expansions).toEqual([]);
  });
  it("refuses missing, wrong-parent and cancelled scope assessments without altering parent", async () => {
    const child = await acceptTacticExpansion(args);
    const baseline = await loadState();
    for (const target of [{expansion_id: "missing", tactic_id: args.tactic_id}, {expansion_id: child.id, tactic_id: baseline.tactics[1]!.id}]) {
      await expect(assignTacticToGap({...target, gap_id: args.gap_id, actor_name: "S4", actor_function: "heor", coverage: "full"})).rejects.toThrow(/scope/i);
    }
    await setExpansionStatus({expansion_id: child.id, status: "cancelled", rationale: "No resources", actor, expected_version: child.version});
    await expect(assignTacticToGap({expansion_id: child.id, tactic_id: child.tactic_id, gap_id: args.gap_id, actor_name: "S4", actor_function: "heor", coverage: "full"})).rejects.toThrow(/cancelled/i);
    expect((await loadState()).coverages).toEqual(baseline.coverages);
  });
  it("offers a versioned human status API while arbitrary proposal acceptance stays unavailable", async () => {
    const child = await acceptTacticExpansion(args);
    const request = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/plan", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({actor_name: actor.name, actor_function: actor.function, ...body})}));
    const payload = {action: "set_expansion_status", expansion_id: child.id, status: "planned", expected_version: child.version, rationale: "Funding approved"};
    const response = await request(payload);
    expect(response.status).toBe(200);
    expect((await response.json()).expansion.status).toBe("planned");
    expect((await request(payload)).status).toBe(400);
    expect((await request({action: "accept_tactic_expansion", ...args})).status).toBe(400);
  });
  it.each([false, true])("S4 supplies distinct child scope targets with recorded design %s and commits only to child assessment", async (recorded) => {
    const child = await acceptTacticExpansion({...args, scope: {...args.scope, ...(recorded ? {type: "subgroup_analysis" as const, comparator:"Active comparator cohort", data_source:"Linked registry"} : {})}});
    const before = await loadState();
    const saved = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    let inventory: {id: string; expansion_id?: string; evidence_question: string; comparator?: string; data_source?: string; type: string}[] = [];
    const ctx: ModuleContext = {
      ai: true, workspace_id: "default", actor, role: "medical_affairs",
      route: {stage: "S4", provider_id: "anthropic-claude", provider_label: "Claude", model: "test", auth: "api_key", connected: true, params: {temperature: 0, max_tokens: 4096}, fallbacks: [], degraded: false, reason: null},
      run: {id: "expansion-test", step: async (_name, fn) => fn(), note: () => {}, steps: () => []},
      complete: async ({purpose, user}) => {
        const body = JSON.parse(user);
        if (purpose === "mapping-table-proposer") {
          inventory = body.tactics;
          return {rows: [{gap_id: args.gap_id, mapping_status: "partially_addressed", confidence: 90, rationale: "Added scope covers population", mappings: [{tactic_id: child.id, coverage: "full", confidence: 90, rationale: "Scoped analysis", dimensions: Object.fromEntries(COVERAGE_DIMENSIONS.map(d => [d, "yes"]))}]}]};
        }
        if (purpose === "mapping-table-critic") return {reviews: [{gap_id: args.gap_id, verdict: "keep", confidence: 90, note: "Scoped", mappings: [{tactic_id: child.id, verdict: "keep", note: "Scoped"}]}]};
        return {verdicts: [{gap_id: args.gap_id, verdict: "accept", confidence: 90, reason: "Scoped"}]};
      },
    };
    try {
      await kgMappingModule.run(kgMappingModule.inputSchema.parse({gap_ids: [args.gap_id]}), ctx);
      expect(inventory.find(t => t.expansion_id === child.id)?.evidence_question).toBe(scope.evidence_question);
      expect(inventory.find(t => t.expansion_id === child.id)?.comparator).toBe(recorded ? "Active comparator cohort" : "");
      expect(inventory.find(t => t.expansion_id === child.id)?.data_source).toBe(recorded ? "Linked registry" : "");
      expect(inventory.find(t => t.expansion_id === child.id)?.type).toBe(recorded ? "subgroup_analysis" : "not_recorded");
      expect(inventory.find(t => t.id === args.tactic_id)?.evidence_question).toBe(before.tactics[0]!.evidence_question);
      const after = await loadState();
      expect(after.coverages.filter(c => !c.expansion_id)).toEqual(before.coverages.filter(c => !c.expansion_id));
      expect(after.coverages.find(c => c.expansion_id === child.id)?.overall).toBe("full");
      expect(after.expansions[0]!.status).toBe("proposed");
    } finally {
      if (saved === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
      else process.env.SYNAPSE_TEST_STUB_LLM = saved;
    }
  });
  it("loads legacy workspaces unchanged and creates a proposed child without rewriting locked parent", async () => {
    const before = await loadState();
    expect(before.expansions).toEqual([]);
    const expansion = await acceptTacticExpansion(args);
    const after = await loadState();
    expect(after.tactics).toEqual(before.tactics);
    expect(after.coverages.filter(c => !c.expansion_id)).toEqual(before.coverages);
    expect(expansion.status).toBe("proposed");
    expect(expansion.history).toHaveLength(1);
    expect(expansion.history[0]).toMatchObject({ action: "accept", actor, rationale: args.rationale });
    expect(after.coverages.filter(c => c.expansion_id === expansion.id)).toHaveLength(1);
    expect(after.audit.filter(a => a.entity_id === expansion.id)).toHaveLength(1);
  });
  it("deduplicates concurrent and repeated acceptance, preserving a distinct second expansion", async () => {
    const [a,b] = await Promise.all([acceptTacticExpansion(args), acceptTacticExpansion(args)]);
    expect(a.id).toBe(b.id);
    expect((await acceptTacticExpansion(args)).id).toBe(a.id);
    const c = await acceptTacticExpansion({ ...args, proposal_id: "s3:suggestion-2", scope: { ...scope, name: "Second analysis" } });
    const state = await loadState();
    expect(state.expansions.map(e => e.id).sort()).toEqual([a.id,c.id].sort());
    expect(state.expansions.every(e => e.history.length === 1)).toBe(true);
    expect(state.coverages.filter(e => e.expansion_id)).toHaveLength(2);
    await expect(acceptTacticExpansion({ ...args, scope: { ...scope, name: "Conflicting retry" } })).rejects.toThrow(/already|different/i);
  });
  it.each([
    ["missing rationale", () => ({ ...args, rationale: "" }), /rationale/i],
    ["stale tactic version", () => ({ ...args, expected_tactic_version: "stale" }), /changed|stale/i],
    ["wrong parent", () => ({ ...args, tactic_id: "TAC-NOT-HERE" }), /tactic/i],
    ["missing gap", () => ({ ...args, gap_id: "GAP-NOT-HERE" }), /gap/i],
    ["missing scope", () => ({ ...args, scope: { ...scope, gap_coverage: "" } }), /scope|coverage/i],
  ])("rejects %s without writing child, scoped coverage or audit", async (_name, input, error) => {
    const before = await loadState();
    await expect(acceptTacticExpansion(input())).rejects.toThrow(error);
    const after = await loadState();
    expect(after.expansions).toEqual([]);
    expect(after.coverages).toEqual(before.coverages);
    expect(after.audit).toEqual(before.audit);
  });
  it("cannot accept a parent or change a child from another workspace", async () => {
    const expansion = await acceptTacticExpansion(args);
    await runInWorkspace({workspace_id: "expansion-other", schema: "ws_expansion_other"}, async () => {
      await expect(acceptTacticExpansion(args)).rejects.toThrow(/tactic/i);
      await expect(setExpansionStatus({expansion_id: expansion.id, status: "planned", rationale: "Plan", actor, expected_version: expansion.version})).rejects.toThrow(/expansion/i);
    });
  });
  it("rolls back a child insert when dependent coverage fails", async () => {
    await db().execute(sql`CREATE OR REPLACE FUNCTION fail_expansion_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.expansion_id IS NOT NULL THEN RAISE EXCEPTION 'injected coverage failure'; END IF; RETURN NEW; END $$`);
    await db().execute(sql`CREATE TRIGGER test_expansion_fail BEFORE INSERT ON coverages FOR EACH ROW EXECUTE FUNCTION fail_expansion_coverage()`);
    const before = await loadState();
    try {
      await expect(acceptTacticExpansion(args)).rejects.toMatchObject({ cause: { message: "injected coverage failure" } });
      const after = await loadState();
      expect(after.expansions).toEqual([]);
      expect(after.coverages).toEqual(before.coverages);
      expect(after.audit).toEqual(before.audit);
    } finally {
      await db().execute(sql`DROP TRIGGER test_expansion_fail ON coverages`);
      await db().execute(sql`DROP FUNCTION fail_expansion_coverage()`);
    }
  });
  it("overrides rejection only for an explicitly accepted child while preserving parent rejection", async () => {
    await rejectMapping({gap_id:args.gap_id, tactic_id:args.tactic_id, actor_name:actor.name, actor_function:actor.function, note:"Rejected base scope"});
    await expect(assignTacticToGap({gap_id:args.gap_id,tactic_id:args.tactic_id, actor_name:"S4",actor_function:"heor"})).rejects.toThrow(/reviewer|rejected|person/i);
    const expansion = await acceptTacticExpansion(args);
    expect((await loadState()).mapping_suggestions.find(m => m.gap_id === args.gap_id && m.tactic_id === args.tactic_id)?.status).toBe("rejected");
    await expect(assignTacticToGap({gap_id: args.gap_id, tactic_id: args.tactic_id, actor_name: "S4", actor_function: "heor"})).rejects.toThrow(/rejected|person/i);
    await assignTacticToGap({gap_id: args.gap_id, tactic_id: args.tactic_id, expansion_id: expansion.id, coverage: "full", actor_name: "S4", actor_function: "heor"});
    const sibling = {...expansion, id: "EXP-UNACCEPTED", proposal_id: "sibling-without-acceptance", history: []};
    await db().insert(tables.tacticExpansions).values(sibling);
    await expect(assignTacticToGap({gap_id: args.gap_id, tactic_id: args.tactic_id, expansion_id: sibling.id, actor_name: "S4", actor_function: "heor"})).rejects.toThrow(/rejected|person/i);
    expect(expansion.status).toBe("proposed");
  });
  it("uses independent status/version/history and updates coverage eligibility without validating Full", async () => {
    const expansion = await acceptTacticExpansion(args);
    await assignTacticToGap({gap_id:args.gap_id, tactic_id:args.tactic_id, expansion_id:expansion.id, coverage:"full", note:"Scoped model assessment", actor_name:"S4",actor_function:"heor"});
    const before = await loadState();
    const planned = await setExpansionStatus({expansion_id:expansion.id,status:"planned",rationale:"Resource committed",actor,expected_version:expansion.version});
    expect(planned.history).toHaveLength(2);
    expect(planned.version).not.toBe(expansion.version);
    const after = await loadState();
    expect(after.tactics).toEqual(before.tactics);
    expect(after.coverages.find(c=>c.expansion_id === expansion.id)?.overall_lock.locked).toBe(false);
    await expect(setExpansionStatus({expansion_id:expansion.id,status:"ongoing",rationale:"Start",actor,expected_version:expansion.version})).rejects.toThrow(/changed|stale/i);
    await expect(setExpansionStatus({expansion_id:expansion.id,status:"ongoing",rationale:"",actor,expected_version:planned.version})).rejects.toThrow(/rationale/i);
  });
});
