import { resolveRouteForRun } from "./run";
/** Compare two instructions against one frozen case set without running the live persistence wrapper. */
import { sql } from 'drizzle-orm';
import type { Actor, EvalCase, EvalScore, ModuleContext, ResolvedRoute, StageId, SynapseModule } from './contracts';
import { ensurePlatformSchema, sharedDb } from './db';
import { activeRevisionPointer, getPromptRevision, getRevisionCohort } from './prompt-revisions';
import { frozenReplayCase, evidenceHash, projectReplayDecision, scoreDecisionReplay, type FrozenReplayCase } from './decision-replay';
import { activeModule } from './registry';
import { completionFor, resolveRoute } from './routing';
import { RunRecorder } from './observability';
import { revisionCompletion, withPromptRevision } from './prompt-variant';
import { withLearningExclusions } from './decision-examples';
import { compositeScore } from './baselines';
import { newId, nowIso } from './ids';
import { getWorkspace } from '@/modules/workspaces/store';
import { DEFAULT_SCHEMA, DEFAULT_WORKSPACE_ID, runInWorkspace } from '@/modules/workspaces/context';
import { assertAiEnabled } from './ai-switch';
import { sectionOfStage } from './ai-sections';
import { isTestStub } from './llm';
export type CountedMetric = EvalScore & {
    numerator: number;
    denominator: number;
};
export type EvaluationArm = {
    gold: CountedMetric[];
    replay: CountedMetric[];
    gold_count: number;
    replay_count: number;
    gold_composite: number;
    replay_composite: number;
    combined: number;
};
export type EvaluationCall = {
    arm: string;
    case_id: string;
    purpose: string;
    max_tokens: number;
    system_hash: string;
    user_hash: string;
};
export type RevisionEvaluation = {
    id: string;
    workspace_id: string;
    revision_id: string;
    stage: StageId;
    created_at: string;
    actor: Actor;
    baseline_revision_id: string | null;
    pointer_generation: number;
    module_id: string;
    module_version: string;
    route: ResolvedRoute;
    route_hash: string;
    cohort_id: string;
    case_hash: string;
    calls: EvaluationCall[];
    gold_cases: unknown[];
    replay_ids: string[];
    excluded: Record<string, string>;
    allowed_example_ids: string[];
    baseline: EvaluationArm;
    candidate: EvaluationArm;
    failures: string[];
    comparable: boolean;
    eligible: boolean;
    reasons: string[];
};
/** Route identity includes provider/model/parameters/fallback policy, not connection display labels. */
export function routeIdentity(route: ResolvedRoute): string { return evidenceHash({ stage: route.stage, provider_id: route.provider_id, model: route.model, params: route.params, fallbacks: route.fallbacks }); }
/** Pure strict gate: complete equal denominators, strict combined improvement, no lower gold metric. */
export function promotionEligibility(e: RevisionEvaluation): {
    eligible: boolean;
    reasons: string[];
} {
    const reasons: string[] = [];
    const b = e.baseline, c = e.candidate;
    if (!e.comparable)
        reasons.push('Runs are not comparable (route, module, cases or execution mode).');
    if (e.failures.length)
        reasons.push(`${e.failures.length} case execution/scoring failure(s).`);
    if (!b.gold_count || !c.gold_count || !b.gold.length || !c.gold.length)
        reasons.push('Nonempty gold evidence is required.');
    if (!b.replay_count || !c.replay_count || !b.replay.length || !c.replay.length)
        reasons.push('Nonempty replay evidence is required.');
    if (b.gold_count !== c.gold_count || b.replay_count !== c.replay_count)
        reasons.push('Case counts differ between arms.');
    for (const kind of ['gold', 'replay'] as const) {
        const left = b[kind], right = c[kind];
        if (left.length !== right.length || new Set(left.map(m => m.name)).size !== left.length || new Set(right.map(m => m.name)).size !== right.length)
            reasons.push(`${kind} metric sets differ or contain duplicates.`);
        for (const metric of left) {
            const other = right.find(m => m.name === metric.name);
            if (!other || metric.denominator <= 0 || metric.denominator !== other.denominator || metric.target !== other.target || metric.unit !== other.unit || !Number.isFinite(metric.value) || !Number.isFinite(other.value))
                reasons.push(`${kind}/${metric.name} has incomplete or incomparable evidence.`);
            else if (kind === 'gold' && other.value < metric.value)
                reasons.push(`Gold metric ${metric.name} regressed.`);
        }
    }
    if (!Number.isFinite(c.combined) || !Number.isFinite(b.combined) || c.combined <= b.combined)
        reasons.push('Combined gold/replay score must strictly improve.');
    return { eligible: !reasons.length, reasons };
}
/** Direct stage computation: all facts/examples are supplied; no runs/evals/domain rows are persisted. */
export async function executeFrozenStage(args: {
    module: SynapseModule<unknown, unknown>;
    snapshot: FrozenReplayCase;
    route: ResolvedRoute;
    revision: {
        id: string | null;
        instruction: string;
    };
    actor: Actor;
    excluded_ids: string[];
    record_call?: (call: Omit<EvaluationCall, "arm" | "case_id">) => void;
}): Promise<unknown> {
    const { module, snapshot } = args;
    if (snapshot.module_id !== module.manifest.id || snapshot.module_version !== module.manifest.version)
        throw new Error('Frozen case belongs to a different stage implementation.');
    if (!snapshot.facts.state || snapshot.stage !== module.manifest.stage)
        throw new Error('Frozen stage facts are incomplete.');
    if ((snapshot.input as {
        apply?: unknown;
    })?.apply)
        throw new Error('A split apply command cannot be replayed.');
    const recorder = new RunRecorder({ workspace_id: snapshot.workspace_id, stage: snapshot.stage, module_id: module.manifest.id, module_version: module.manifest.version, actor: args.actor, input: snapshot.input });
    const examples = snapshot.examples.filter(e => !args.excluded_ids.includes(e.id));
    const complete = completionFor(args.route, recorder);
    const observed: typeof complete = async (call) => { args.record_call?.({ purpose: call.purpose, max_tokens: call.maxTokens ?? args.route.params.max_tokens, system_hash: evidenceHash(call.system), user_hash: evidenceHash(call.user) }); return complete(call); };
    const ctx: ModuleContext = { workspace_id: snapshot.workspace_id, actor: args.actor, role: 'owner', run: recorder, route: args.route, ai: true, complete: revisionCompletion(observed, args.revision.instruction), replay: { evaluation: true, input: snapshot.input, facts: structuredClone(snapshot.facts), examples, module_id: module.manifest.id, module_version: module.manifest.version, prompt_version: args.revision.id ?? 'v1.0-baseline' } };
    return withPromptRevision(args.revision, () => withLearningExclusions(args.excluded_ids, async () => {
        const input = module.inputSchema.parse(structuredClone(snapshot.input));
        const result = await module.run(input, ctx);
        return module.outputSchema.parse(result.output);
    }));
}
function aggregate(cases: EvalScore[][]): CountedMetric[] {
    const names = [...new Set(cases.flat().map(m => m.name))];
    return names.map(name => { const scores = cases.flat().filter(m => m.name === name); const numerator = scores.reduce((sum, m) => sum + m.value, 0); return { ...scores[0], name, value: numerator / scores.length, numerator, denominator: scores.length, detail: `Sum of case scores ${numerator} / ${scores.length} scored cases` }; });
}
/** Freeze once, run both arms, persist immutable evidence; this never activates an instruction. */
export async function evaluatePromptRevision(args: {
    revision_id: string;
    workspace_id: string;
    actor: Actor;
}): Promise<RevisionEvaluation> {
    await ensurePlatformSchema();
    const revision = await getPromptRevision(args.revision_id, args.workspace_id);
    if (!revision)
        throw new Error('Unknown candidate in this workspace.');
    const workspace = await getWorkspace(args.workspace_id);
    if (!workspace && args.workspace_id !== DEFAULT_WORKSPACE_ID)
        throw new Error('Unknown workspace.');
    return runInWorkspace({ workspace_id: args.workspace_id, schema: workspace?.schema_name ?? DEFAULT_SCHEMA }, async () => {
        await assertAiEnabled('Prompt evaluation', sectionOfStage(revision.stage) ?? undefined);
        const cohort = await getRevisionCohort(revision.cohort_id, args.workspace_id);
        if (!cohort)
            throw new Error('Frozen candidate cohort is missing.');
        const pointer = await activeRevisionPointer(args.workspace_id, revision.stage);
        const active = pointer.revision_id ? await getPromptRevision(pointer.revision_id, args.workspace_id) : null;
        const module = await activeModule(revision.stage);
        if (!module.freeze)
            throw new Error('Stage has no isolated facts contract.');
        const route = await resolveRouteForRun(revision.stage);
        const failures: string[] = [];
        const excluded: Record<string, string> = {};
        // Gold harness cases are loaded exactly once. Each stage owns its existing score semantics.
        // Reuse pre-execution snapshots for gold too: calling live loaders here can migrate,
        // bootstrap or renumber domain records even when a caller asks for a dry run.
        const snapshotRows = await sharedDb().execute(sql `select snapshot from prompt_replay_snapshots where workspace_id=${args.workspace_id} and stage=${revision.stage} order by run_id`);
        const source = snapshotRows.map(r => r.snapshot as FrozenReplayCase).find(s => s.version === 1 && s.module_id === module.manifest.id && s.module_version === module.manifest.version && !!s.facts.state);
        const cases = source ? structuredClone(await module.evals?.cases(source.facts) ?? []) : [];
        const gold: {
            testCase: EvalCase<unknown>;
            snapshot: FrozenReplayCase;
        }[] = [];
        for (const testCase of cases) {
            try {
                const input = module.inputSchema.parse(testCase.input);
                gold.push({ testCase, snapshot: { ...source!, run_id: `gold:${testCase.name}`, input, facts: structuredClone(source!.facts), examples: [], route } });
            }
            catch (error) {
                failures.push(`Gold ${testCase.name}: ${String(error)}`);
            }
        }
        const replay = cohort.examples.filter(e => cohort.heldout_ids.includes(e.id)).flatMap(example => {
            const snapshot = frozenReplayCase(example);
            let reason = example.replay_exclusion_reason;
            if (!snapshot)
                reason = reason ?? 'No complete frozen originating facts.';
            else if (snapshot.module_id !== module.manifest.id || snapshot.module_version !== module.manifest.version)
                reason = 'Originating stage version differs.';
            else if (!['s4_mapping', 's8_band', 's9_proposal'].includes(example.kind))
                reason = 'This originating decision lacks a stable supported replay subject/target.';
            else if (example.kind === 's9_proposal' && (typeof example.ai_input.slot_id !== 'string' || !Object.values(snapshot.facts.proposal_slots ?? {}).some(slots => Array.isArray(slots) && slots.includes(example.ai_input.slot_id))))
                reason = 'Proposal has no complete frozen slot correspondence.';
            // Validate the target independently of any generated response.
            else {
                const target = example.outcome === 'accepted' ? example.ai_output : example.final;
                const probe = { kind: example.kind, subject_id: example.subject_id, decision: example.outcome === 'rejected' ? 'reject' : 'accept', band: target?.band ?? target?.suggested_band, mapping_status: target?.mapping_status ?? target?.status, tactic_ids: target?.tactic_ids, fields: target };
                reason = scoreDecisionReplay(example, probe).reason;
            }
            if (reason || !snapshot) {
                excluded[example.id] = reason ?? 'Unreplayable context.';
                return [];
            }
            return [{ example, snapshot: { ...snapshot, examples: snapshot.examples.filter(e => !cohort.excluded_ids.includes(e.id)) } }];
        });
        const calls: EvaluationCall[] = [];
        const runArm = async (instruction: {
            id: string | null;
            instruction: string;
        }): Promise<EvaluationArm> => {
            const goldScores: EvalScore[][] = [], replayScores: EvalScore[][] = [];
            for (const item of gold)
                try {
                    const output = await executeFrozenStage({ module, snapshot: item.snapshot, route, revision: instruction, actor: args.actor, excluded_ids: cohort.excluded_ids, record_call: call => calls.push({ ...call, arm: instruction.id ?? "baseline", case_id: item.testCase.name }) });
                    const scores = module.evals!.score({ case: item.testCase, output });
                    if (!scores.length)
                        throw new Error('No gold scores');
                    goldScores.push(scores);
                }
                catch (error) {
                    failures.push(`${instruction.id ?? 'baseline'} gold ${item.testCase.name}: ${String(error)}`);
                }
            for (const item of replay)
                try {
                    const output = await executeFrozenStage({ module, snapshot: item.snapshot, route, revision: instruction, actor: args.actor, excluded_ids: cohort.excluded_ids, record_call: call => calls.push({ ...call, arm: instruction.id ?? "baseline", case_id: item.example.id }) });
                    const scored = scoreDecisionReplay(item.example, projectReplayDecision(item.example, output));
                    if (scored.reason)
                        throw new Error(scored.reason);
                    replayScores.push(scored.metrics);
                }
                catch (error) {
                    failures.push(`${instruction.id ?? 'baseline'} replay ${item.example.id}: ${String(error)}`);
                }
            const gm = aggregate(goldScores), rm = aggregate(replayScores);
            const gc = compositeScore(gm), rc = compositeScore(rm);
            return { gold: gm, replay: rm, gold_count: goldScores.length, replay_count: replayScores.length, gold_composite: gc, replay_composite: rc, combined: (gc + rc) / 2 };
        };
        const baseline = await runArm({ id: active?.id ?? null, instruction: active?.instruction_text ?? '' });
        const candidate = await runArm({ id: revision.id, instruction: revision.instruction_text });
        const evidence: RevisionEvaluation = { id: newId('pre'), workspace_id: args.workspace_id, revision_id: revision.id, stage: revision.stage, created_at: nowIso(), actor: args.actor, baseline_revision_id: pointer.revision_id, pointer_generation: pointer.generation, module_id: module.manifest.id, module_version: module.manifest.version, route, route_hash: routeIdentity(route), cohort_id: cohort.id, case_hash: evidenceHash({ gold, replay, excluded: cohort.excluded_ids }), calls, gold_cases: gold, replay_ids: replay.map(x => x.example.id), excluded, allowed_example_ids: [...new Set(replay.flatMap(x => x.snapshot.examples.map(e => e.id)))], baseline, candidate, failures, comparable: revision.parent_revision === (pointer.revision_id ?? 'v1.0-baseline') && !isTestStub() && routeIdentity(await resolveRouteForRun(revision.stage)) === routeIdentity(route), eligible: false, reasons: [] };
        Object.assign(evidence, promotionEligibility(evidence));
        await sharedDb().transaction(async (tx) => {
            await tx.execute(sql `select pg_advisory_xact_lock(hashtext(${`prompt-evaluation:${revision.id}`}))`);
            await tx.execute(sql `insert into prompt_revision_evaluations(id,workspace_id,revision_id,created_at,evidence) values(${evidence.id},${args.workspace_id},${revision.id},${evidence.created_at},${JSON.stringify(evidence)}::jsonb)`);
            await tx.execute(sql `update prompt_revisions set state='evaluated' where id=${revision.id} and state='candidate'`);
        });
        return evidence;
    });
}
/** Workspace-bound immutable evaluation lookup. */
export async function getRevisionEvaluation(id: string, workspace_id: string): Promise<RevisionEvaluation | null> {
    await ensurePlatformSchema();
    const rows = await sharedDb().execute(sql `select evidence from prompt_revision_evaluations where id=${id} and workspace_id=${workspace_id}`);
    return rows[0]?.evidence as RevisionEvaluation ?? null;
}
/** Report evidence metadata without exposing raw frozen workspace cases in list responses. */
export async function listRevisionEvaluations(workspace_id: string): Promise<Omit<RevisionEvaluation, 'gold_cases'>[]> {
    await ensurePlatformSchema();
    const rows = await sharedDb().execute(sql `select evidence - 'gold_cases' as evidence from prompt_revision_evaluations where workspace_id=${workspace_id} order by created_at desc`);
    return rows.map(r => r.evidence as Omit<RevisionEvaluation, 'gold_cases'>);
}
