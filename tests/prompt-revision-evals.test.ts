import { priorityDecision } from "./support/priority-decision";
/** Strict comparable evidence gates promotion independently of execution. */
import { describe, it, expect } from 'vitest';
import { promotionEligibility, type RevisionEvaluation } from '@/modules/kernel/prompt-revision-evals';
const evaluation = () => ({ baseline: { gold: [{ name: 'accuracy', value: .8, denominator: 2 }], replay: [{ name: 'agreement', value: .6, denominator: 2 }], gold_count: 2, replay_count: 2, combined: .7 }, candidate: { gold: [{ name: 'accuracy', value: .8, denominator: 2 }], replay: [{ name: 'agreement', value: .8, denominator: 2 }], gold_count: 2, replay_count: 2, combined: .8 }, failures: [], comparable: true }) as unknown as RevisionEvaluation;
describe('promotion eligibility', () => {
    it('withholds a historical aggregate with no paired observations', () => {
        expect(promotionEligibility(evaluation()).eligible).toBe(false);
    });
    it('refuses missing cases, failures, mismatched routes and incomplete metrics', () => {
        for (const mutate of [(x: RevisionEvaluation) => x.candidate.gold_count = 0, (x: RevisionEvaluation) => x.baseline.replay_count = 0, (x: RevisionEvaluation) => x.failures.push('failed'), (x: RevisionEvaluation) => x.comparable = false, (x: RevisionEvaluation) => x.candidate.gold = []]) {
            const x = evaluation();
            mutate(x);
            expect(promotionEligibility(x).eligible).toBe(false);
        }
    });
});
import { afterEach, vi } from 'vitest';
import '@/modules';
import { sql } from 'drizzle-orm';
import { db, sharedDb } from '@/modules/kernel/db';
import * as tables from '@/modules/kernel/schema';
import * as routing from '@/modules/kernel/routing';
import * as llm from '@/modules/kernel/llm';
import * as store from '@/lib/iegp/store';
import * as examples from '@/modules/kernel/decision-examples';
import { forgetSchemaBootstrap } from "@/lib/iegp/db";
import { withEvaluationIsolation } from "@/modules/kernel/evaluation-isolation";
import { createWorkspace, setWorkspaceDemoMode } from '@/modules/workspaces/store';
import { runInWorkspace } from '@/modules/workspaces/context';
import { runStage } from '@/modules/kernel/run';
import { proposePromptRevision, getRevisionCohort, activatePromptRevision, rollbackPromptRevision, activeRevisionPointer, revisionHistory } from '@/modules/kernel/prompt-revisions';
import { evaluatePromptRevision, executeFrozenStage } from '@/modules/kernel/prompt-revision-evals';
import * as audit from "@/modules/kernel/audit";
import { parsePlanningContext, setupContextFromState } from "@/lib/iegp/planning-context";
import { targetMetrics } from "@/modules/kernel/revision-policy";
import { listAuditEvents } from '@/modules/kernel/audit';
import { originatingSnapshot, type FrozenReplayCase } from '@/modules/kernel/decision-replay';
import { kgMappingModule } from '@/modules/stages/s4-kg-mapping/module';
import { frozenPriorityReviewHash } from "@/modules/stages/s8-prioritization/review-basis";
import { prioritizationModule } from '@/modules/stages/s8-prioritization/module';
import type { ResolvedRoute, SynapseModule } from '@/modules/kernel/contracts';
import { newId } from '@/modules/kernel/ids';
const actor = { name: 'Evaluation Owner', function: 'medical_affairs' as const };
/** Adds a reviewed evidence question to the live replay source workspace. */
async function createReviewedGap(name: string, statement: string) {
    const reviewer = { actor_name: actor.name, actor_function: actor.function };
    const id = await store.createGap({ name, statement, ...reviewer });
    await store.validateGap({ gap_id: id, note: "Reviewed before running the live stage", ...reviewer });
    return id;
}

const route: ResolvedRoute = { stage: 'S8', provider_id: 'anthropic-claude', provider_label: 'test', model: 'scripted-model', auth: 'api_key', connected: true, params: { temperature: 0, max_tokens: 4000 }, fallbacks: [], degraded: false, reason: null };
afterEach(() => vi.restoreAllMocks());
async function evaluationFixture() {
    const ws = await createWorkspace({ name: `eval-${crypto.randomUUID()}`, owner: 'eval-test' });
    return runInWorkspace({ workspace_id: ws.id, schema: ws.schema_name }, async () => {
        scriptedModel();
        const ids:string[]=[];
        const lessons=["Reviewers separate timing from importance.","Reviewers require a distinct comparison.","Withheld timing.","Withheld population.","Withheld outcome."];
        await store.loadState();
        await db().execute(sql`insert into assets(id,name,inn,indication,geography) values('asset','Fictionbrand','','','') on conflict(id) do update set name=excluded.name`);
        const cases:FrozenReplayCase[]=[];
        const addReviews:(()=>PromiseLike<unknown>)[]=[];
        for(let i=0;i<5;i++) {
            const statement=`Missing comparative evidence for fictional question ${i}.`;
            const gapId=await createReviewedGap(`Fictional question ${i}`, statement);
            const run=await runStage({stage:"S8",input:{gap_ids:[gapId],x_axis:"decision_impact",y_axis:"time_pressure"},actor,role:"medical_affairs"});
            const snapshot=await originatingSnapshot(run.run_id,ws.id,"S8") as unknown as FrozenReplayCase;
            expect(snapshot.execution).toBe("routed");
            cases.push(snapshot);
            const id=newId("dex");ids.push(id);
            addReviews.push(()=>sharedDb().execute(sql`insert into decision_examples(id,workspace_id,stage,kind,subject_id,run_id,actor_principal,ai_input,ai_output,outcome,final,lesson,lesson_status,created_at,model,provider_id,prompt_version,priority_review_hash,replay_input)
                values(${id},${ws.id},'S8','s8_band',${gapId},${run.run_id},${"fiction-reviewer-"+i},
                ${JSON.stringify({gap:{statement}})}::jsonb,'{"band":"high"}'::jsonb,'edited','{"band":"defer"}'::jsonb,
                ${lessons[i]},'ok',${'2026-01-0'+(i+1)},${route.model},${route.provider_id},'v1.0-baseline',${frozenPriorityReviewHash(snapshot,gapId)},${JSON.stringify(snapshot)}::jsonb)`));
        }
        for(const addReview of addReviews)await addReview();
        const revision=await proposePromptRevision({stage:"S8",workspace_id:ws.id,actor,exclude_ids:[]});
        expect([...revision.training_ids].sort()).toEqual(ids.slice(0,2).sort());
        expect([...revision.heldout_ids].sort()).toEqual(ids.slice(2).sort());
        const snapshot=cases[0];
        const gap=(snapshot.facts.state as Awaited<ReturnType<typeof store.loadState>>).gaps[0];
        return { ws, revision, snapshot, gap };
    });
}
function scriptedModel() {
    vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
    vi.spyOn(routing,'routeConfigs').mockResolvedValue([{...route,updated_by:"fixture",updated_at:"2026-01-01"}]);
    vi.spyOn(routing, 'resolveRoute').mockResolvedValue(route);
    const calls: {
        system: string;
        user: string;
        purpose: string;
    }[] = [];
    vi.spyOn(routing, 'completionFor').mockImplementation(() => async (args) => {
        calls.push(args);
        const body = JSON.parse(args.user);
        if (args.purpose === 'prompt-revision') return { instruction_text: 'Candidate instruction' };
        if (args.purpose === 'decision-lesson') return { lesson: 'Reviewers require a complete decision question.' };
        if (args.purpose === 'priority-critic')
            return { reviews: body.placements.map((p: {
                    gap_id: string;
                }) => ({ gap_id: p.gap_id, verdict: 'keep', confidence: 90, note: 'Supported' })) };
        const candidate = args.system.includes('Candidate instruction');
        return { gaps: body.gaps.map((gap: {
                id: string;
            }) => ({ gap_id: gap.id, scores: Object.fromEntries(body.axes.map((axis: {
                    id: string;
                }) => [axis.id, candidate ? 20 : 80])), rationale: 'Evidence supports this placement.', references:[{entity_type:'gap',entity_id:gap.id,reason:'The supplied gap defines the decision.'}] })) };
    });
    return calls;
}
async function liveContents() {
    const names = ['gaps', 'tactics', 'gap_tactic_coverage', 'module_runs', 'edit_records', 'hillclimb_signals', 'priority_placements', 'ideation_proposals'];
    const result: Record<string, unknown> = {};
    for (const name of names) {
        const exists = await db().execute(sql `select to_regclass(${name}) as name`);
        if (exists[0]?.name)
            result[name] = await db().execute(sql.raw(`select to_jsonb(t) as row from ${name} t order by to_jsonb(t)::text`));
    }
    result.decisions = await sharedDb().execute(sql `select * from decision_examples order by id`);
    result.evals = await sharedDb().execute(sql `select * from eval_runs order by id`);
    return result;
}
describe('isolated full-stage evaluation and atomic promotion', () => {
    it('captures genuine pre-execution facts, scores both arms and changes no live records', async () => {
        const f = await evaluationFixture();
        const calls = scriptedModel();
        await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
            const legacyPriority = "evaluation-legacy-priority";
            const legacyResidual = "evaluation-legacy-residual";
            await db().execute(sql`insert into residuals (id,gap_id,statement,domain,draft_rationale,lock)
                values (${legacyResidual},${f.gap.id},'Legacy evidence','safety','','{}'::jsonb)`);
            await db().execute(sql`insert into priorities (id,residual_id,suggested_score,suggested_band,band,reasons,lock)
                values (${legacyPriority},${legacyResidual},0,'low','low','[]'::jsonb,'{"locked":true}'::jsonb)`);
            await db().execute(sql`delete from priority_placements where gap_id=${f.gap.id}`);
            const legacyMarker = async () => (await db().execute(sql`select carried_over_at from priorities where id=${legacyPriority}`))[0]?.carried_over_at;
            const before = await liveContents();
            forgetSchemaBootstrap(f.ws.schema_name);
            await expect(runStage({ stage: 'S8', workspace_id: 'foreign', input: {}, actor, role: 'medical_affairs' })).rejects.toThrow('database scope');
            // Any hidden live reader would either leak post-decision facts or run schema/bootstrap writes.
            vi.spyOn(store, 'loadState').mockRejectedValue(new Error('live state reader forbidden during replay'));
            vi.spyOn(examples, 'similarExamples').mockRejectedValue(new Error('live retrieval forbidden during replay'));
            const result = await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            expect(result.failures).toEqual([]);
            expect(result.baseline.gold_count).toBe(3);
            expect(result.candidate.replay_count).toBe(0);
            expect(result.candidate.combined).toBeGreaterThan(result.baseline.combined);
            expect(result.eligible).toBe(true);
            expect(await withEvaluationIsolation(liveContents)).toEqual(before);
            expect(await withEvaluationIsolation(legacyMarker)).toBeNull();
            expect(await activeRevisionPointer(f.ws.id, 'S8')).toEqual({ revision_id: null, generation: 0 });
            expect(calls.filter(c => c.purpose === 'priority-critic')).toHaveLength(54);
            expect(calls.some(c => c.system.includes('Candidate instruction'))).toBe(true);
            expect(result.allowed_example_ids.some(id => f.revision.heldout_ids.includes(id))).toBe(false);
            await expect(sharedDb().execute(sql `update prompt_revision_evaluations set evidence='{}' where id=${result.id}`)).rejects.toThrow();
            await expect(evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: 'foreign', actor })).rejects.toThrow('Unknown');
            expect(await legacyMarker()).toEqual(expect.any(String));
        });
    });
    it('allows only one concurrent approval, refuses stale evidence, then rollback restores live instructions', async () => {
        const f = await evaluationFixture();
        const calls = scriptedModel();
        await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
            const evaluation = await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            const outcomes = await Promise.allSettled([1, 2].map(() => activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })));
            expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
            expect((await revisionHistory(f.ws.id))).toHaveLength(1);
            calls.length = 0;
            await runStage({ stage: 'S8', workspace_id: f.ws.id, input: { dry_run: true }, actor, role: 'medical_affairs' });
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.every(c => c.system.includes('Candidate instruction'))).toBe(true);
            expect(await rollbackPromptRevision({ stage: 'S8', expected_active_id: f.revision.id, actor })).toBeNull();
            calls.length = 0;
            await runStage({ stage: 'S8', workspace_id: f.ws.id, input: { dry_run: true }, actor, role: 'medical_affairs' });
            expect(calls.every(c => !c.system.includes('Candidate instruction'))).toBe(true);
            await expect(activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })).rejects.toThrow('changed');
            expect((await revisionHistory(f.ws.id))).toHaveLength(2);
            // KAN-89: the one approval and the rollback are in the platform audit log, failed approvals are not.
            const audited = (await listAuditEvents({ category: 'config', entity_id: f.revision.id })).events;
            expect(audited.map(e => e.action)).toEqual(['prompt.rollback', 'prompt.approve', 'prompt.generate']);
            expect(audited[1].before).toMatchObject({ stage: 'S8', active_revision: null });
            expect(audited[1].after).toMatchObject({ stage: 'S8', active_revision: f.revision.id });
            expect(audited[0].after).toMatchObject({ active_revision: null });
        });
    });
    it('revalidates demo mode at the approval transaction before touching the active pointer', async () => {
        const f = await evaluationFixture();
        await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
            const evaluation = await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            expect(evaluation.eligible).toBe(true);
            vi.mocked(routing.resolveRoute).mockImplementationOnce(async () => {
                await setWorkspaceDemoMode(f.ws.id, true);
                return route;
            });
            await expect(activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })).rejects.toThrow(/workspace with live routing/);
            expect(await activeRevisionPointer(f.ws.id, 'S8')).toEqual({ revision_id: null, generation: 0 });
            expect(await revisionHistory(f.ws.id)).toEqual([]);
        });
    });
    it('refuses promotion after the evaluated stage manifest version changes', async () => {
        const f = await evaluationFixture();
        scriptedModel();
        await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
            const evaluation = await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            expect(evaluation.eligible).toBe(true);
            const evaluatedVersion = prioritizationModule.manifest.version;
            try {
                prioritizationModule.manifest.version = `${evaluatedVersion}-changed`;
                await expect(activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })).rejects.toThrow('Stage implementation changed since evaluation.');
                expect(await activeRevisionPointer(f.ws.id, 'S8')).toEqual({ revision_id: null, generation: 0 });
                expect(await revisionHistory(f.ws.id)).toEqual([]);
            } finally {
                prioritizationModule.manifest.version = evaluatedVersion;
            }
        });
    });
    it('refuses changed route and mutation input without executing a stage', async () => {
        const f = await evaluationFixture();
        scriptedModel();
        await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
            const evaluation = await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            const same=await evaluatePromptRevision({revision_id:f.revision.id,workspace_id:f.ws.id,actor});
            expect(same.id).toBe(evaluation.id);
            vi.mocked(routing.resolveRoute).mockResolvedValue({ ...route, model: 'different-model' });
            await expect(activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })).rejects.toThrow(/Routing changed|cannot be served/);
            await expect(executeFrozenStage({ module: prioritizationModule as SynapseModule<unknown, unknown>, snapshot: { ...f.snapshot, input: { apply: {} } }, route, revision: { id: null, instruction: '' }, actor, excluded_ids: [] })).rejects.toThrow('apply command');
        });
    });
});
import { listPlacements, setPlacement, validatePlacement } from '@/modules/stages/s8-prioritization/module';
import { ideationModule, decideIdeationProposal, listIdeationProposals } from '@/modules/stages/s9-ideation/module';
import { frozenReplayCase, projectReplayDecision, scoreDecisionReplay } from '@/modules/kernel/decision-replay';
it("binds a saved human correction to the original priority context and axes", async () => {
    const ws = await createWorkspace({ name: "Priority review " + crypto.randomUUID(), owner: "fixture-reviewer" });
    const author = { actor_name: actor.name, actor_function: actor.function };
    const matrix = { x_axis: "decision_impact", y_axis: "time_pressure" };
    scriptedModel();
    vi.spyOn(audit, "currentAttribution").mockResolvedValue({
        principal: "fixture-reviewer", name: actor.name, role: actor.function, request_id: null, workspace_id: ws.id,
    });
    await runInWorkspace({ workspace_id: ws.id, schema: ws.schema_name }, async () => {
        await store.saveProductSetup({ ...author, reason: "Record the fictional dossier deadline",
            context: parsePlanningContext({ asset_name: "Fixture", objectives: [
                { name: "Dossier submission", evidence_needed_by: "2028-06-01", decision_date: "2028-07-01" },
            ] }) });
        const state = await store.loadState();
        const gap_id = await store.createGap({ ...author, name: "Durability", statement: "Comparative durability estimates are missing.",
            objective_id: state.objectives[0]!.id });
        await store.validateGap({ ...author, gap_id, note: "Review the durability evidence before prioritizing it" });
        const run = await runStage({ stage: "S8", input: { gap_ids: [gap_id], ...matrix }, actor, role: actor.function });
        async function capturedBand(band: "low" | "defer" | "medium") {
            const rows = await examples.listDecisionExamples({ workspace_id: ws.id, stage: "S8" });
            const captured = rows.find(row => row.run_id === run.run_id && row.final?.band === band)!;
            expect(captured.actor_principal).toBe("fixture-reviewer");
            return captured;
        }
        async function confirm(band: "low" | "medium") {
            const decision = await priorityDecision(gap_id, "Review the comparative evidence deadline");
            await validatePlacement({ ...decision, ...matrix, gap_id, band, actor, workspace_id: ws.id });
            return capturedBand(band);
        }
        const current = await confirm("low");
        expect(current.replay_exclusion_reason).toBeNull();
        expect(targetMetrics(current)).toEqual(["band_agreement"]);
        await setPlacement({ ...await priorityDecision(gap_id, "Review decision impact against feasibility"),
            gap_id, actor, workspace_id: ws.id, x_axis: "decision_impact", y_axis: "feasibility",
            axis_scores: { decision_impact: 20, feasibility: 20 }, validate: true });
        const alternate = await capturedBand("defer");
        expect(alternate.replay_exclusion_reason).toMatch(/matrix axes differ/);
        expect(targetMetrics(alternate)).toEqual([]);

        const updated = setupContextFromState(await store.loadState());
        updated.objectives[0]!.evidence_needed_by = "2028-03-01";
        await store.saveProductSetup({ ...author, context: updated, reason: "Bring the evidence deadline forward" });
        expect((await listPlacements()).find(row => row.gap_id === gap_id)?.needs_review).toBe(true);
        const later = await confirm("medium");
        expect(later.replay_exclusion_reason).toMatch(/reviewed priority context/);
        expect(targetMetrics(later)).toEqual([]);
        expect((await listPlacements()).find(row => row.gap_id === gap_id)).toMatchObject({ validated: true, band: "medium" });
    });
});

it('preserves future S9 pre-generation slots through a rationale-only edit and full isolated replay', async () => {
    const f = await evaluationFixture();
    await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
        await validatePlacement({ ...await priorityDecision(f.gap.id, 'This blocks the decision.'), gap_id: f.gap.id, band: 'high', rationale: 'This blocks the decision.', actor, workspace_id: f.ws.id });
        vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
        vi.spyOn(routing, 'resolveRoute').mockImplementation(async (stage) => ({ ...route, stage }));
        const calls: string[] = [];
        vi.spyOn(routing, 'completionFor').mockImplementation(() => async (args) => {
            calls.push(args.user);
            const body = JSON.parse(args.user);
            if (args.purpose === 'decision-lesson') return { lesson: 'Reviewers require a complete decision question.' };
            if (args.purpose === 'prompt-revision') return { instruction_text: 'Candidate instruction' };
            if (args.purpose === 'ideation-critic')
                return { reviews: body.tactics.map((t: {
                        id: string; gap_id: string;
                    }) => ({ id: t.id, verdict: 'keep', confidence: 90, note: 'Supported', duplicate_of: null, references: [{ entity_type: 'gap', entity_id: t.gap_id, reason: 'This supplied gap defines the evidence need' }] })) };
            if (args.purpose === 'ideation-judge')
                return { gaps: body.gaps.map((g: {
                        id: string;
                        candidates: {
                            id: string;
                        }[];
                    }) => ({ gap_id: g.id, outcome: { status: "options", explanation: "A candidate serves the gap." }, decisions: g.candidates.map((p, index) => ({ id: p.id, verdict: 'accept', rank: index + 1, confidence: 90, reason: 'Complete design', references: [{ entity_type: 'gap', entity_id: g.id, reason: 'The supplied gap identifies the evidence need' }] })) })) };
            return { tactics: body.gaps.flatMap((g: {
                    id: string;
                    proposal_slots: string[];
                }) => g.proposal_slots.map(id => ({ id, gap_id: g.id, contract_version: 2, proposal_kind:'new',target_tactic_id:null,expansion_scope:null, name: 'Original study', type: 'rwe_study', evidence_question: 'Compare outcomes', references: [{ entity_type: 'gap', entity_id: g.id, reason: 'The supplied gap defines this study question' }], rationale: args.system.includes('Edited design') ? 'Corrected proposal explanation' : 'Answer the evidence gap', comparative_rationale:'New registry answers unavailable scope; credible feasibility but slower and costlier than secondary analysis', population: 'Adults', comparator: 'Standard care', outcomes: 'Survival', data_source: 'Registry', study_design: 'Retrospective cohort', duration_months: 12, readout_lag_months: 2, timing_rationale: 'Annual data cycle', recommendation: { remaining_need: 'Recorded comparative evidence remains unresolved.', incremental_contribution: 'The registry supplies the missing comparative evidence.', alternatives_rationale: 'A new registry is slower but addresses the unmet comparison.', feasibility: { status: 'conditional', required_checks: ['Confirm registry access and comparator compatibility.'] }, coverage_discrepancy: null, deadline: { status: 'unknown', explanation: 'Confirm availability against the decision date.' } } }))) };
        });
        const live = await runStage({ stage: 'S9', workspace_id: f.ws.id, input: { gap_ids: [f.gap.id], per_gap: 1 }, actor, role: 'medical_affairs' });
        const [proposal] = await listIdeationProposals();
        expect(proposal).toBeTruthy();
        const snapshot = await originatingSnapshot(live.run_id, f.ws.id, 'S9') as unknown as FrozenReplayCase;
        expect(JSON.stringify(snapshot)).not.toContain('Original study');
        expect(snapshot.facts.proposal_slots).toMatchObject({ [f.gap.id]: [`${f.gap.id}:proposal:1`] });
        await expect(executeFrozenStage({module:ideationModule as SynapseModule<unknown,unknown>,snapshot:{...snapshot,module_version:'2.1.0'},route:{...route,stage:'S9'},revision:{id:null,instruction:''},actor,excluded_ids:[]})).rejects.toThrow('different stage implementation');
        const accepted = await decideIdeationProposal({ id: proposal.id, decision: 'accept', rationale: 'The proposal explanation needs correction.', actor, workspace_id: f.ws.id, fields: { idea_rationale:'Corrected proposal explanation' } });
        const [decision] = await examples.listDecisionExamples({ workspace_id: f.ws.id, stage: 'S9' });
        await vi.waitFor(async () => expect((await examples.getDecisionExample(decision.id))?.lesson_status).toBe('ok'));
        await vi.waitFor(async () => {
            const pending = await db().execute(sql`select id from module_runs where module_id='learning.lesson' and status='running'`);
            expect(pending).toHaveLength(0);
        });
        expect(decision.outcome).toBe('edited');
        expect(decision.ai_input.slot_id).toBe(`${f.gap.id}:proposal:1`);
        const afterAcceptance = await ideationModule.freeze!({ gap_ids: [f.gap.id], per_gap: 1, dry_run: true });
        expect(afterAcceptance.proposal_lineage).toEqual(expect.arrayContaining([expect.objectContaining({ subject_id: decision.subject_id, tactic_id: accepted.tactic_id, run_id: live.run_id, gap_id: f.gap.id })]));
        expect(ideationModule.evals!.reserveGold).toBeTypeOf('function');
        const reserved = await ideationModule.evals!.reserveGold!(afterAcceptance, [f.gap.id]);
        expect(reserved.cases).toHaveLength(1);
        expect(reserved.cases[0].input.gap_ids).toEqual([f.gap.id]);
        expect(reserved.lineage_subject_ids).toContain(decision.subject_id);
        expect(reserved.lineage_run_ids).toContain(live.run_id);
        const legacy = { ...afterAcceptance }; delete legacy.proposal_lineage;
        expect((await ideationModule.evals!.reserveGold!(legacy, [f.gap.id])).cases).toEqual([]);
        const frozen = frozenReplayCase(decision)!;
        expect(frozen).not.toBeNull();
        const before = await liveContents();
        vi.spyOn(store, 'loadState').mockRejectedValue(new Error('Forbidden current state'));
        const output = await executeFrozenStage({ module: ideationModule as SynapseModule<unknown, unknown>, snapshot: frozen, route: { ...route, stage: 'S9' }, revision: { id: 'candidate', instruction: 'Edited design' }, actor, excluded_ids: [decision.id] });
        const score = scoreDecisionReplay(decision, projectReplayDecision(decision, output));
        expect(score.reason).toBeNull();
        expect(score.metrics).toHaveLength(15);
        expect(score.metrics.every(m => m.value === 1)).toBe(true);
        const originalOutput = await executeFrozenStage({ module: ideationModule as SynapseModule<unknown, unknown>, snapshot: frozen, route: { ...route, stage: 'S9' }, revision: { id: 'original', instruction: 'Original design' }, actor, excluded_ids: [decision.id] });
        expect(scoreDecisionReplay(decision, projectReplayDecision(decision,originalOutput)).metrics.find(m=>m.name==='rationale_literal_agreement')?.value).toBe(0);
        expect(await liveContents()).toEqual(before);
        const o = output as {
            proposals: unknown[];
        };
        expect(projectReplayDecision(decision, { ...o, proposals: [...o.proposals, ...o.proposals] })).toBeNull();
        expect(projectReplayDecision(decision, { proposals: [], rejected: [] })).toBeNull();
        expect(calls.some(call => call.includes('proposal_slots'))).toBe(true);
        vi.mocked(store.loadState).mockRestore();
        // Kernel lineage fixture uses the acceptance linkage just captured above.
        // A library proposal is excluded even though only a different gap is gold.
        const state = structuredClone(afterAcceptance.state) as Awaited<ReturnType<typeof store.loadState>>;
        state.gaps.push({ ...state.gaps[0], id: 'reserved-gap' });
        const reservedRun = 'reserved-run';
        const reservedSnapshot = { ...snapshot, run_id: reservedRun, input: { gap_ids: ['reserved-gap'], per_gap: 1 }, facts: { ...afterAcceptance, state, placements: [{ ...(afterAcceptance.placements as Record<string, unknown>[])[0], gap_id: 'reserved-gap' }], proposal_slots: { 'reserved-gap': ['reserved-gap:proposal:1'] } } };
        const trainingId = (await examples.recordDecisionExample({ workspace_id: f.ws.id, stage: 'S9', kind: 's9_proposal', subject_id: 'training-proposal', ai_input: {}, ai_output: {}, outcome: 'rejected' }))!;
        const heldId = (await examples.recordDecisionExample({ workspace_id: f.ws.id, stage: 'S9', kind: 's9_proposal', subject_id: 'reserved-proposal', run_id: reservedRun, ai_input: { slot_id: 'reserved-gap:proposal:1' }, ai_output: {}, outcome: 'rejected', replay_input: reservedSnapshot }))!;
        for (const id of [trainingId, heldId]) await vi.waitFor(async () => expect((await examples.getDecisionExample(id))?.lesson_status).toBe('ok'));
        await sharedDb().execute(sql`update decision_examples set lesson='Reviewers require withheld library consistency.', created_at='2026-01-01' where id=${decision.id}`);
        await sharedDb().execute(sql`update decision_examples set lesson='Reviewers separate timing from importance.', created_at='2026-02-01' where id=${trainingId}`);
        await sharedDb().execute(sql`update decision_examples set lesson='Reviewers require withheld gap specificity.', created_at='2026-03-01' where id=${heldId}`);
        await expect(proposePromptRevision({stage:"S9",workspace_id:f.ws.id,actor,exclude_ids:[]})).rejects.toThrow("human target");
        expect(calls.map(call=>JSON.parse(call)).some(body=>body.lessons)).toBe(false);

    });
});


it('keeps the pre-generation reservation after later customer activity', async () => {
    const f=await evaluationFixture();
    await runInWorkspace({workspace_id:f.ws.id,schema:f.ws.schema_name},async()=>{
        const before=await getRevisionCohort(f.revision.cohort_id,f.ws.id);
        await createReviewedGap("Later gap", "New evidence after generation.");
        await runStage({stage:"S8",input:{dry_run:true},actor,role:"medical_affairs"});
        const result=await evaluatePromptRevision({revision_id:f.revision.id,workspace_id:f.ws.id,actor});
        expect(result.gold_cases).toEqual(before!.gold_reservation!.cases);
        expect(result.allowed_example_ids).toEqual([]);
        expect(result.eligible).toBe(true);
        expect(await getRevisionCohort(f.revision.cohort_id,"foreign")).toBeNull();
        await expect(sharedDb().execute(sql`update prompt_revision_cohorts set heldout_ids='[]' where id=${f.revision.cohort_id}`)).rejects.toThrow();
    });
});

it('refuses legacy gold even when newer workspace snapshots exist or old evidence says eligible', async () => {
    const f = await evaluationFixture();
    scriptedModel();
    await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
        const cohort = (await getRevisionCohort(f.revision.cohort_id, f.ws.id))!;
        const legacyCohort = { ...cohort, id: newId('prc'), gold_reservation: null };
        await sharedDb().insert(tables.promptRevisionCohorts).values(legacyCohort);
        const legacyRevision = { ...f.revision, id: newId('prv'), cohort_id: legacyCohort.id };
        await sharedDb().insert(tables.promptRevisions).values(legacyRevision);
        await expect(evaluatePromptRevision({revision_id:legacyRevision.id,workspace_id:f.ws.id,actor})).rejects.toThrow("reserved before generation");
        const previouslyEligible = { ...await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor }), id: newId('pre'), revision_id: legacyRevision.id, cohort_id: legacyCohort.id };
        expect(previouslyEligible.eligible).toBe(true);
        await sharedDb().execute(sql`insert into prompt_revision_evaluations(id,workspace_id,revision_id,created_at,evidence) values(${previouslyEligible.id},${f.ws.id},${legacyRevision.id},${previouslyEligible.created_at},${JSON.stringify(previouslyEligible)}::jsonb)`);
        await expect(activatePromptRevision({ revision_id: legacyRevision.id, evaluation_id: previouslyEligible.id, expected_active_id: null, actor })).rejects.toThrow(/ineligible|lineage/);
    });
});


it('reserves S4 gap subsets while keeping the selected gaps human rejection memory and score denominators', async () => {
    const f = await evaluationFixture();
    const state = structuredClone(f.snapshot.facts.state) as Awaited<ReturnType<typeof store.loadState>>;
    state.gaps.push({ ...state.gaps[0], id: 'other-gap', name: 'Training gap' });
    state.mapping_suggestions = [f.gap.id, 'other-gap'].map(gap_id => ({ gap_id, tactic_id: 'tactic', status: 'rejected', lock: { locked: true } })) as typeof state.mapping_suggestions;
    expect(kgMappingModule.evals!.reserveGold).toBeTypeOf('function');
    const reserved = await kgMappingModule.evals!.reserveGold!({ state }, [f.gap.id]);
    const frozen = reserved.facts.state as typeof state;
    expect(frozen.gaps.map(gap => gap.id)).toEqual([f.gap.id]);
    expect(frozen.mapping_suggestions.map(row => row.gap_id)).toEqual([f.gap.id]);
    expect(store.humanRejectedPairs(frozen)).toContain(`${f.gap.id}::tactic`);
    expect(reserved.cases[0].input.gap_ids).toEqual([f.gap.id]);
    const scores = kgMappingModule.evals!.score({ case: reserved.cases[0], output: { accepted: [], rejected: [], table: { gaps_still_open: 1 } } as never });
    expect(scores.find(metric => metric.name === 'gaps_left_unmapped')?.value).toBe(1);
});
