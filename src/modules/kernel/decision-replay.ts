/** Frozen originating facts and typed human-target agreement; no historical facts are reconstructed. */
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { sharedDb } from './db';
import type { DecisionExample, DecisionKind, WorkedExample } from './decision-examples';
import type { ModuleContext, ResolvedRoute, StageId } from './contracts';
export type FrozenReplayCase = {
    version: 1;
    workspace_id: string;
    stage: StageId;
    run_id: string;
    module_id: string;
    module_version: string;
    prompt_version: string;
    input: unknown;
    facts: Record<string, unknown>;
    examples: WorkedExample[];
    route: ResolvedRoute;
};
export type ReplayMetric = {
    name: string;
    value: number;
    numerator: number;
    denominator: number;
};
export type ReplayScore = {
    metrics: ReplayMetric[];
    reason: string | null;
};
export type DecisionProjection = {
    kind: DecisionKind;
    subject_id: string;
    decision: 'accept' | 'reject';
    band?: string;
    mapping_status?: string;
    tactic_ids?: string[];
    classification?: string;
    fields?: Record<string, unknown>;
};
/** Stable JSON identity used to bind immutable facts and route parameters to an evaluation. */
export function evidenceHash(value: unknown): string {
    const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
/** Store full pre-execution context separately from size-limited observability steps. */
export async function saveReplaySnapshot(ctx: ModuleContext, stage: StageId, examples: WorkedExample[]): Promise<void> {
    if (!ctx.replay || ctx.replay.evaluation)
        return;
    const snapshot: FrozenReplayCase = { version: 1, workspace_id: ctx.workspace_id, stage, run_id: ctx.run.id, module_id: ctx.replay.module_id, module_version: ctx.replay.module_version, prompt_version: ctx.replay.prompt_version, input: ctx.replay.input, facts: ctx.replay.facts, examples, route: ctx.route };
    await sharedDb().execute(sql `insert into prompt_replay_snapshots (run_id, workspace_id, stage, snapshot) values (${ctx.run.id}, ${ctx.workspace_id}, ${stage}, ${JSON.stringify(snapshot)}::jsonb) on conflict (run_id) do nothing`);
    ctx.run.note('replay:frozen', { hash: evidenceHash(snapshot), run_id: ctx.run.id });
}
/** Fetch only the verified originating run's same-workspace context. */
export async function originatingSnapshot(run_id: string, workspace_id: string, stage: StageId): Promise<Record<string, unknown> | null> {
    const rows = await sharedDb().execute(sql `select snapshot from prompt_replay_snapshots where run_id=${run_id} and workspace_id=${workspace_id} and stage=${stage}`);
    return rows[0]?.snapshot as Record<string, unknown> ?? null;
}
/** Reject old, incomplete or foreign envelopes rather than rebuilding them from current state. */
export function frozenReplayCase(example: DecisionExample): FrozenReplayCase | null {
    const value = example.replay_input as FrozenReplayCase | null;
    return value?.version === 1 && value.workspace_id === example.workspace_id && value.stage === example.stage && value.run_id === example.run_id && !!value.facts?.state && !!value.module_id && !!value.module_version && !!value.route && Array.isArray(value.examples) && !!value.input ? value : null;
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
/** Literal field agreement: each scored field contributes one match out of one known target. */
export function scoreDecisionReplay(example: DecisionExample, output: unknown): ReplayScore {
    const excluded = (reason: string): ReplayScore => ({ metrics: [], reason });
    if (example.kind === 'residual_split')
        return excluded('Residual split has no approved replay target contract.');
    const p = record(output);
    if (p.kind !== example.kind || p.subject_id !== example.subject_id || !['accept', 'reject'].includes(String(p.decision)))
        return excluded('No explicit, unambiguous decision for the originating subject.');
    const metrics: ReplayMetric[] = [];
    const metric = (name: string, match: boolean) => metrics.push({ name, value: Number(match), numerator: Number(match), denominator: 1 });
    metric('decision_agreement', p.decision === (example.outcome === 'rejected' ? 'reject' : 'accept'));
    if (example.outcome === 'rejected')
        return { metrics, reason: null };
    const target = example.outcome === 'accepted' ? example.ai_output : example.final;
    if (!target)
        return excluded('The final human target is missing.');
    if (example.kind === 's8_band') {
        const band = target.band ?? target.suggested_band;
        if (!['high', 'medium', 'low', 'defer'].includes(String(band)))
            return excluded('No validated priority band target.');
        metric('band_agreement', p.band === band);
    }
    else if (example.kind === 's4_mapping') {
        const status = target.mapping_status ?? target.status;
        if (typeof status !== 'string')
            return excluded('No explicit coverage verdict target.');
        metric('coverage_verdict_agreement', p.mapping_status === status);
        if (Array.isArray(target.tactic_ids))
            metric('tactic_set_agreement', evidenceHash([...(p.tactic_ids as string[] ?? [])].sort()) === evidenceHash([...target.tactic_ids].sort()));
    }
    else if (example.kind === 'gap_suggestion') {
        if (!['same', 'overlaps', 'new'].includes(String(target.classification)))
            return excluded('Legacy merge/split choices do not determine a match classification.');
        metric('classification_agreement', p.classification === target.classification);
    }
    else {
        const fields = ['name', 'type', 'evidence_question'];
        const designFields = ['population', 'comparator', 'outcomes', 'data_source', 'study_design', 'duration_months', 'readout_lag_months', 'timing_rationale'];
        const design = record(target.design);
        const actual = record(p.fields);
        const actualDesign = record(actual.design);
        if (fields.some(k => target[k] == null) || designFields.some(k => design[k] == null))
            return excluded('Proposal target lacks required final design fields.');
        for (const k of fields)
            metric(`${k}_literal_agreement`, evidenceHash(target[k]) === evidenceHash(actual[k] ?? null));
        for (const k of designFields)
            metric(`${k}_literal_agreement`, evidenceHash(design[k]) === evidenceHash(actualDesign[k] ?? null));
    }
    return { metrics, reason: null };
}
/** Resolve stable gap identities; generated proposal IDs cannot be guessed from text or array order. */
export function projectReplayDecision(example: DecisionExample, output: unknown): DecisionProjection | null {
    const o = record(output);
    const find = (key: string, idKey: string) => Array.isArray(o[key]) ? (o[key] as Record<string, unknown>[]).find(r => r[idKey] === example.subject_id) : undefined;
    if (example.kind === 's8_band') {
        const row = find('placements', 'gap_id');
        return row ? { kind: example.kind, subject_id: example.subject_id, decision: 'accept', band: String(row.suggested_band) } : null;
    }
    if (example.kind === 's9_proposal') {
        const slot = example.ai_input.slot_id;
        const snapshot = frozenReplayCase(example);
        const slots = record(snapshot?.facts.proposal_slots);
        if (typeof slot !== 'string' || !Object.values(slots).some(value => Array.isArray(value) && value.includes(slot)))
            return null;
        const accepted = (Array.isArray(o.proposals) ? o.proposals : []) as Record<string, unknown>[];
        const rejected = (Array.isArray(o.rejected) ? o.rejected : []) as Record<string, unknown>[];
        const withdrawn = (Array.isArray(o.withdrawn) ? o.withdrawn : []) as Record<string, unknown>[];
        const matches = [...accepted.filter(r => r.id === slot).map(row => ({ decision: 'accept' as const, row })), ...rejected.filter(r => r.id === slot).map(row => ({ decision: 'reject' as const, row })), ...withdrawn.filter(r => r.slot_id === slot).map(row => ({ decision: 'reject' as const, row }))];
        if (matches.length !== 1)
            return null;
        return { kind: example.kind, subject_id: example.subject_id, decision: matches[0].decision, fields: matches[0].row };
    }
    if (example.kind === 's4_mapping') {
        const row = find('accepted', 'gap_id');
        const rejected = find('rejected', 'gap_id') ?? find('withdrawn', 'gap_id');
        return row ? { kind: example.kind, subject_id: example.subject_id, decision: 'accept', mapping_status: String(row.mapping_status ?? row.status), tactic_ids: row.tactic_ids as string[] } : rejected ? { kind: example.kind, subject_id: example.subject_id, decision: 'reject' } : null;
    }
    return null;
}
