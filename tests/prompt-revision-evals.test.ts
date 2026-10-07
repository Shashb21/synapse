/** Strict comparable evidence gates promotion independently of execution. */
import { describe, it, expect } from 'vitest';
import { promotionEligibility, type RevisionEvaluation } from '@/modules/kernel/prompt-revision-evals';
const evaluation = () => ({ baseline: { gold: [{ name: 'accuracy', value: .8, denominator: 2 }], replay: [{ name: 'agreement', value: .6, denominator: 2 }], gold_count: 2, replay_count: 2, combined: .7 }, candidate: { gold: [{ name: 'accuracy', value: .8, denominator: 2 }], replay: [{ name: 'agreement', value: .8, denominator: 2 }], gold_count: 2, replay_count: 2, combined: .8 }, failures: [], comparable: true }) as unknown as RevisionEvaluation;
describe('promotion eligibility', () => {
    it('requires strict improvement and no individual gold regression', () => {
        expect(promotionEligibility(evaluation()).eligible).toBe(true);
        const equal = evaluation();
        equal.candidate.combined = .7;
        expect(promotionEligibility(equal).eligible).toBe(false);
        const regression = evaluation();
        regression.candidate.gold[0].value = .7;
        expect(promotionEligibility(regression).eligible).toBe(false);
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
import { createWorkspace } from '@/modules/workspaces/store';
import { runInWorkspace } from '@/modules/workspaces/context';
import { runStage } from '@/modules/kernel/run';
import { freezeRevisionCohort, proposePromptRevision, getRevisionCohort, activatePromptRevision, rollbackPromptRevision, activeRevisionPointer, revisionHistory, type PromptRevision } from '@/modules/kernel/prompt-revisions';
import { evaluatePromptRevision, executeFrozenStage } from '@/modules/kernel/prompt-revision-evals';
import { originatingSnapshot, type FrozenReplayCase } from '@/modules/kernel/decision-replay';
import { kgMappingModule } from '@/modules/stages/s4-kg-mapping/module';
import { prioritizationModule } from '@/modules/stages/s8-prioritization/module';
import type { ResolvedRoute, SynapseModule } from '@/modules/kernel/contracts';
import { newId } from '@/modules/kernel/ids';
const actor = { name: 'Evaluation Owner', function: 'medical_affairs' as const };
const route: ResolvedRoute = { stage: 'S8', provider_id: 'anthropic-claude', provider_label: 'test', model: 'scripted-model', auth: 'api_key', connected: true, params: { temperature: 0, max_tokens: 4000 }, fallbacks: [], degraded: false, reason: null };
afterEach(() => vi.restoreAllMocks());
async function evaluationFixture() {
    const ws = await createWorkspace({ name: `eval-${crypto.randomUUID()}`, owner: 'eval-test' });
    return runInWorkspace({ workspace_id: ws.id, schema: ws.schema_name }, async () => {
        await store.createGap({ name: 'Missing comparative evidence', statement: 'Evidence for the payer decision is missing.', actor_name: actor.name, actor_function: actor.function });
        const live = await runStage({ stage: 'S8', input: { x_axis: 'decision_impact', y_axis: 'time_pressure' }, actor, role: 'medical_affairs' });
        const snapshot = await originatingSnapshot(live.run_id, ws.id, 'S8') as unknown as FrozenReplayCase;
        expect(snapshot.facts.state).toBeTruthy();
        expect(snapshot.workspace_id).toBe(ws.id);
        const gap = (snapshot.facts.state as Awaited<ReturnType<typeof store.loadState>>).gaps[0];
        const id = await examples.recordDecisionExample({ workspace_id: ws.id, stage: 'S8', kind: 's8_band', subject_id: gap.id, run_id: live.run_id, ai_input: {}, ai_output: { band: 'high' }, outcome: 'edited', final: { band: 'defer' } });
        const cohort = await freezeRevisionCohort({ workspace_id: ws.id, stage: 'S8', exclude_ids: [] });
        expect(cohort.heldout_ids).toContain(id);
        expect(cohort.examples[0].replay_input).toMatchObject({ run_id: live.run_id });
        const revision: PromptRevision = { id: newId('prv'), workspace_id: ws.id, stage: 'S8', parent_revision: 'v1.0-baseline', instruction_text: 'Candidate instruction', creator: actor, created_at: new Date().toISOString(), state: 'candidate', cohort_id: cohort.id, training_ids: [], heldout_ids: cohort.heldout_ids, excluded_ids: cohort.excluded_ids, generation_run_id: 'fixture', model: route.model, provider_id: route.provider_id };
        await sharedDb().insert(tables.promptRevisions).values(revision);
        return { ws, revision, snapshot, gap };
    });
}
function scriptedModel() {
    vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
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
                }) => [axis.id, candidate ? 20 : 80])), rationale: 'Evidence supports this placement.' })) };
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
            const before = await liveContents();
            await expect(runStage({ stage: 'S8', workspace_id: 'foreign', input: {}, actor, role: 'medical_affairs' })).rejects.toThrow('database scope');
            // Any hidden live reader would either leak post-decision facts or run schema/bootstrap writes.
            vi.spyOn(store, 'loadState').mockRejectedValue(new Error('live state reader forbidden during replay'));
            vi.spyOn(examples, 'similarExamples').mockRejectedValue(new Error('live retrieval forbidden during replay'));
            const result = await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            expect(result.failures).toEqual([]);
            expect(result.baseline.gold_count).toBe(1);
            expect(result.candidate.replay_count).toBe(1);
            expect(result.candidate.combined).toBeGreaterThan(result.baseline.combined);
            expect(result.eligible).toBe(true);
            expect(await liveContents()).toEqual(before);
            expect(await activeRevisionPointer(f.ws.id, 'S8')).toEqual({ revision_id: null, generation: 0 });
            expect(calls.filter(c => c.purpose === 'priority-critic')).toHaveLength(12);
            expect(calls.some(c => c.system.includes('Candidate instruction'))).toBe(true);
            expect(result.allowed_example_ids.some(id => f.revision.heldout_ids.includes(id))).toBe(false);
            await expect(sharedDb().execute(sql `update prompt_revision_evaluations set evidence='{}' where id=${result.id}`)).rejects.toThrow();
            await expect(evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: 'foreign', actor })).rejects.toThrow('Unknown');
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
            await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor });
            await expect(activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })).rejects.toThrow('newer evaluation');
            vi.mocked(routing.resolveRoute).mockResolvedValue({ ...route, model: 'different-model' });
            await expect(activatePromptRevision({ revision_id: f.revision.id, evaluation_id: evaluation.id, expected_active_id: null, actor })).rejects.toThrow('Routing changed');
            await expect(executeFrozenStage({ module: prioritizationModule as SynapseModule<unknown, unknown>, snapshot: { ...f.snapshot, input: { apply: {} } }, route, revision: { id: null, instruction: '' }, actor, excluded_ids: [] })).rejects.toThrow('apply command');
        });
    });
});
import { validatePlacement } from '@/modules/stages/s8-prioritization/module';
import { ideationModule, decideIdeationProposal, listIdeationProposals } from '@/modules/stages/s9-ideation/module';
import { frozenReplayCase, projectReplayDecision, scoreDecisionReplay } from '@/modules/kernel/decision-replay';
it('preserves future S9 pre-generation slots through human edit and full isolated replay', async () => {
    const f = await evaluationFixture();
    await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
        await validatePlacement({ gap_id: f.gap.id, band: 'high', rationale: 'This blocks the decision.', actor, workspace_id: f.ws.id });
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
                        id: string;
                    }) => ({ id: t.id, verdict: 'keep', confidence: 90, note: 'Supported', duplicate_of: null })) };
            if (args.purpose === 'ideation-judge')
                return { gaps: body.gaps.map((g: {
                        id: string;
                        candidates: {
                            id: string;
                        }[];
                    }) => ({ gap_id: g.id, decisions: g.candidates.map((p, index) => ({ id: p.id, verdict: 'accept', rank: index + 1, confidence: 90, reason: 'Complete design' })) })) };
            return { tactics: body.gaps.flatMap((g: {
                    id: string;
                    proposal_slots: string[];
                }) => g.proposal_slots.map(id => ({ id, gap_id: g.id, name: args.system.includes('Edited design') ? 'Human-approved study' : 'Original study', type: 'rwe_study', evidence_question: 'Compare outcomes', rationale: 'Answer the evidence gap', comparative_rationale:'New registry answers unavailable scope; credible feasibility but slower and costlier than secondary analysis', population: 'Adults', comparator: 'Standard care', outcomes: 'Survival', data_source: 'Registry', study_design: 'Retrospective cohort', duration_months: 12, readout_lag_months: 2, timing_rationale: 'Annual data cycle' }))) };
        });
        const live = await runStage({ stage: 'S9', workspace_id: f.ws.id, input: { gap_ids: [f.gap.id], per_gap: 1 }, actor, role: 'medical_affairs' });
        const [proposal] = await listIdeationProposals();
        expect(proposal).toBeTruthy();
        const snapshot = await originatingSnapshot(live.run_id, f.ws.id, 'S9') as unknown as FrozenReplayCase;
        expect(JSON.stringify(snapshot)).not.toContain('Original study');
        expect(snapshot.facts.proposal_slots).toEqual({ [f.gap.id]: [`${f.gap.id}:proposal:1`] });
        const accepted = await decideIdeationProposal({ id: proposal.id, decision: 'accept', rationale: 'Use the approved study title.', actor, workspace_id: f.ws.id, fields: { name: 'Human-approved study' } });
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
        expect(score.metrics).toHaveLength(14);
        expect(score.metrics.every(m => m.value === 1)).toBe(true);
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
        const revision = await proposePromptRevision({ stage: 'S9', workspace_id: f.ws.id, actor, exclude_ids: [] });
        expect(revision.training_ids).toEqual([trainingId]);
        expect(revision.excluded_ids).toEqual(expect.arrayContaining([decision.id, heldId]));
        const cohort = (await getRevisionCohort(revision.cohort_id, f.ws.id))!;
        expect(cohort.gold_reservation!.cases).toHaveLength(1);
        expect(cohort.gold_reservation!.subject_ids).toEqual(expect.arrayContaining([decision.subject_id, 'reserved-gap']));
        expect(cohort.gold_reservation!.run_ids).toContain(live.run_id);
        const generation = calls.map(call => JSON.parse(call)).find(body => body.lessons);
        expect(generation.lessons).toEqual(['Reviewers separate timing from importance.']);

    });
});


it('reserves held-out gold before real proposal generation and never trains on its subjects', async () => {
    const f = await evaluationFixture();
    await runInWorkspace({ workspace_id: f.ws.id, schema: f.ws.schema_name }, async () => {
        await store.createGap({ name: 'Withheld safety comparison', statement: 'The withheld safety answer is unknown.', actor_name: actor.name, actor_function: actor.function });
        const heldGap = (await store.loadState()).gaps.find(g => g.name === 'Withheld safety comparison')!;
        const trainingRun = await runStage({ stage: 'S8', input: { gap_ids: [f.gap.id] }, actor, role: 'medical_affairs' });
        const trainingId = (await examples.recordDecisionExample({ workspace_id: f.ws.id, stage: 'S8', kind: 's8_band', subject_id: f.gap.id, run_id: trainingRun.run_id, ai_input: {}, ai_output: { band: 'high' }, outcome: 'edited', final: { band: 'defer' } }))!;
        await sharedDb().execute(sql`update decision_examples set created_at='2025-01-01' where id=${f.revision.heldout_ids[0]}`);
        const live = await runStage({ stage: 'S8', input: { gap_ids: [heldGap.id], x_axis: 'decision_impact', y_axis: 'time_pressure' }, actor, role: 'medical_affairs' });
        const heldId = (await examples.recordDecisionExample({ workspace_id: f.ws.id, stage: 'S8', kind: 's8_band', subject_id: heldGap.id, run_id: live.run_id, ai_input: {}, ai_output: { band: 'high' }, outcome: 'edited', final: { band: 'defer' } }))!;
        // A second decision on that run must also be withheld, including its separate lesson.
        const linkedId = (await examples.recordDecisionExample({ workspace_id: f.ws.id, stage: 'S8', kind: 's8_band', subject_id: 'linked-subject', run_id: live.run_id, ai_input: {}, ai_output: { band: 'high' }, outcome: 'edited', final: { band: 'defer' } }))!;
        await sharedDb().execute(sql`update decision_examples set lesson_status='ok', lesson='Reviewers separate timing from importance.', created_at='2026-01-01' where id=${trainingId}`);
        await sharedDb().execute(sql`update decision_examples set lesson_status='ok', lesson='Reviewers demand withheld safety comparisons.', created_at='2026-02-01' where id=${heldId}`);
        await sharedDb().execute(sql`update decision_examples set lesson_status='ok', lesson='Reviewers demand withheld linked decisions.', created_at='2026-02-02', replay_exclusion_reason='Linked fixture has no output correspondence.' where id=${linkedId}`);
        const calls = scriptedModel();
        const revision = await proposePromptRevision({ stage: 'S8', workspace_id: f.ws.id, actor, exclude_ids: [] });
        expect(revision.training_ids).toEqual([trainingId]);
        expect(revision.excluded_ids).toEqual(expect.arrayContaining([heldId, linkedId]));
        const generation = calls.filter(c => c.purpose === 'prompt-revision');
        expect(generation).toHaveLength(1);
        expect(generation[0].user).toContain('Reviewers separate timing from importance.');
        expect(JSON.stringify(generation)).not.toMatch(/withheld|defer|linked-subject/i);
        const cohort = await getRevisionCohort(revision.cohort_id, f.ws.id);
        const reservation = cohort!.gold_reservation!;
        expect(reservation?.cases).toHaveLength(1);
        const reserved = JSON.stringify(reservation);
        expect((reservation.cases[0].snapshot.facts.state as { gaps: { id: string }[] }).gaps.map(g => g.id)).toEqual([heldGap.id]);
        expect(reservation.cases[0].snapshot.input).toMatchObject({ gap_ids: [heldGap.id] });
        const retrieved = await examples.withLearningExclusions(revision.excluded_ids, () => examples.similarExamples({ stage: 'S8', workspace_id: f.ws.id, text: 'priority decision', take: 100 }));
        expect(retrieved.some(e => revision.excluded_ids.includes(e.id))).toBe(false);
        // New snapshots after generation cannot be chosen as extra gold or change its facts.
        await store.createGap({ name: 'Later gap', statement: 'A later snapshot must never enter this cohort.', actor_name: actor.name, actor_function: actor.function });
        await runStage({ stage: 'S8', input: { dry_run: true }, actor, role: 'medical_affairs' });
        const result = await evaluatePromptRevision({ revision_id: revision.id, workspace_id: f.ws.id, actor });
        expect(result.failures).toEqual([]);
        expect(result.baseline.gold_count).toBe(1);
        expect(result.baseline.replay_count).toBe(1);
        expect(result.candidate.replay_count).toBe(1);
        expect(result.eligible).toBe(true);
        expect(JSON.stringify((await getRevisionCohort(revision.cohort_id, f.ws.id))!.gold_reservation)).toBe(reserved);
        expect(result.gold_cases).toEqual(reservation.cases);
        expect(result.allowed_example_ids.some(id => revision.excluded_ids.includes(id))).toBe(false);
        // An originating replay run that evaluated the whole workspace must also
        // reserve A, even when only B's human decision was captured on that run.
        const broad = await runStage({ stage: 'S8', input: { dry_run: true }, actor, role: 'medical_affairs' });
        const broadId = (await examples.recordDecisionExample({ workspace_id: f.ws.id, stage: 'S8', kind: 's8_band', subject_id: heldGap.id, run_id: broad.run_id, ai_input: {}, ai_output: { band: 'high' }, outcome: 'edited', final: { band: 'defer' } }))!;
        await vi.waitFor(async () => expect((await examples.getDecisionExample(broadId))?.lesson_status).toBe('ok'));
        await expect(proposePromptRevision({ stage: 'S8', workspace_id: f.ws.id, actor, exclude_ids: [] })).rejects.toThrow('No validated disagreement lessons');

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
        const result = await evaluatePromptRevision({ revision_id: legacyRevision.id, workspace_id: f.ws.id, actor });
        expect(result.gold_cases).toEqual([]);
        expect(result.excluded.gold).toContain('Legacy candidate');
        expect(result.baseline.gold_count).toBe(0);
        expect(result.eligible).toBe(false);
        const previouslyEligible = { ...await evaluatePromptRevision({ revision_id: f.revision.id, workspace_id: f.ws.id, actor }), id: newId('pre'), revision_id: legacyRevision.id, cohort_id: legacyCohort.id };
        expect(previouslyEligible.eligible).toBe(true);
        await sharedDb().execute(sql`insert into prompt_revision_evaluations(id,workspace_id,revision_id,created_at,evidence) values(${previouslyEligible.id},${f.ws.id},${legacyRevision.id},${previouslyEligible.created_at},${JSON.stringify(previouslyEligible)}::jsonb)`);
        await expect(activatePromptRevision({ revision_id: legacyRevision.id, evaluation_id: previouslyEligible.id, expected_active_id: null, actor })).rejects.toThrow('not reserved before generation');
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
