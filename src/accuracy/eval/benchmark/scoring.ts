/** Pure human-adjudicated scoring. No inferred semantic matches or persistence. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FrozenReferencePack } from './inputs';
import type { ExtractFinding } from './extract';
import { provenanceSpanSchema, validateQuoteAgainstBlock } from '../../store/quote-validator';
export type ScoringStage = 'need_extract' | 'inventory_extract';
const identityText = z.string().trim().min(1);
const signed = { findingId: identityText, reviewerId: identityText, reviewedAt: z.iso.datetime({ offset: true }), signature: identityText, rationale: identityText };
const recordSchema = z.discriminatedUnion('outcome', [
    z.strictObject({ ...signed, outcome: z.literal('match'), meanings: z.array(z.strictObject({ goldId: identityText, essentialMeaning: identityText })).min(1) }),
    z.strictObject({ ...signed, outcome: z.literal('duplicate'), duplicateOf: identityText }),
    z.strictObject({ ...signed, outcome: z.literal('addition'), evidence: z.array(provenanceSpanSchema).min(1) }),
    z.strictObject({ ...signed, outcome: z.literal('unsupported') }),
    z.strictObject({ ...signed, outcome: z.literal('specificity_failure'), goldIds: z.array(identityText).min(1) }),
]);
export type HumanJudgment = z.infer<typeof recordSchema>;
export type ScoringIdentity = {
    packId: string;
    sourceHash: string;
    referenceHash: string;
    packHash: string;
    referenceVersion: string;
    stage: ScoringStage;
    outputHash: string;
};
export type HumanJudgments = {
    identity: ScoringIdentity;
    records: HumanJudgment[];
};
export type ScoreRatio = {
    numerator: number;
    denominator: number;
    percent: number | null;
};
export type StageScore = {
    identity: ScoringIdentity;
    provisional: boolean;
    contentRecall: ScoreRatio;
    citationValidity: ScoreRatio;
    contentWithCitation: ScoreRatio;
    omissions: string[];
    parsingLossIds: string[];
    pending: string[];
    duplicates: string[];
    additions: string[];
    unsupported: string[];
    specificityFailures: HumanJudgment[];
    items: {
        findingId: string;
        citationValid: boolean;
        judgment: HumanJudgment | null;
    }[];
    recovered: {
        goldId: string;
        findingId: string;
        essentialMeaning: string;
        citationValid: boolean;
    }[];
};
/** Canonical JSON preserves array order and omits undefined object properties. */
function canonical(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const r = value as Record<string, unknown>;
        return `{${Object.keys(r).filter(k => r[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
/** Reject duplicated identities instead of hiding output counts. */
function unique(ids: string[]): void {
    if (new Set(ids).size !== ids.length) {
        throw new Error('Duplicate identity');
    }
}
/** Create the identity a human signs; rejects invalid stages and repeated output IDs.
 * Hash binds every normalized finding field, including citations and identifying details.
 */
export function scoringIdentity(pack: FrozenReferencePack, stage: ScoringStage, findings: ExtractFinding[]): ScoringIdentity {
    z.enum(['need_extract', 'inventory_extract']).parse(stage);
    unique(findings.map(f => identityText.parse(f.id)));
    return {
        packId: pack.packId,
        sourceHash: pack.sourceHash,
        referenceHash: pack.referenceHash,
        packHash: pack.packHash,
        referenceVersion: pack.referenceVersion,
        stage,
        outputHash: createHash('sha256').update(canonical(findings)).digest('hex'),
    };
}
/** Score explicit signed decisions only. Throws on stale identities, invalid evidence,
 * unsigned judgments, repeated credit, unknown IDs or duplicate chains. Pending gold
 * or output review yields provisional results. Caller authenticates reviewer signatures.
 */
export function scoreStage(pack: FrozenReferencePack, stage: ScoringStage, findings: ExtractFinding[], humanJudgments: HumanJudgments): StageScore {
    const identity = scoringIdentity(pack, stage, findings);
    if (canonical(identity) !== canonical(humanJudgments.identity))
        throw new Error('Stale scoring identity; rescore all configurations');
    const gold = pack.gold[stage === 'need_extract' ? 'needs' : 'tactics'];
    if (gold.review.status === 'approved') {
        identityText.parse(gold.review.reviewerId);
        z.iso.datetime({ offset: true }).parse(gold.review.reviewedAt);
        if (Date.parse(gold.review.reviewedAt) > Date.parse(pack.frozenAt))
            throw new Error('Gold review after freeze');
    }
    if (gold.review.status === 'approved' && gold.review.referenceVersion !== pack.referenceVersion)
        throw new Error('Gold review version mismatch');
    unique(gold.items.map(g => g.id));
    unique(gold.parsingLossIds);
    const lossIds = gold.items.filter(g => g.parsingLoss).map(g => g.id);
    if (canonical([...lossIds].sort()) !== canonical([...gold.parsingLossIds].sort()))
        throw new Error('Parsing loss identity mismatch');
    const records = z.array(recordSchema).parse(humanJudgments.records);
    unique(records.map(r => r.findingId));
    const byFinding = new Map(findings.map(f => [f.id, f]));
    const byGold = new Map(gold.items.map(g => [g.id, g]));
    const byReview = new Map(records.map(r => [r.findingId, r]));
    /** Verify literal evidence at the original source/block boundary. */
    function evidenceValid(span: z.infer<typeof provenanceSpanSchema>): boolean {
        const block = pack.source.blocks.find(block => block.id === span.block_id);
        return span.source_file_id === pack.packId
            && !!block
            && validateQuoteAgainstBlock({ block, quote: span.quote }).ok;
    }
    const citationValid = new Map(findings.map(f => [
        f.id,
        f.citation.valid && f.provenance.length > 0 && f.provenance.every(evidenceValid),
    ]));
    const recovered: StageScore['recovered'] = [];
    const credited = new Set<string>();
    for (const r of records) {
        if (!byFinding.has(r.findingId))
            throw new Error('Unknown finding');
        if (Date.parse(r.reviewedAt) > Date.now())
            throw new Error('Future review');
        if (r.outcome === 'match') {
            unique(r.meanings.map(m => m.goldId));
            for (const m of r.meanings) {
                const g = byGold.get(m.goldId);
                if (!g || g.parsingLoss || credited.has(m.goldId))
                    throw new Error('Unknown, lost or already credited gold');
                credited.add(m.goldId);
                recovered.push({ ...m, findingId: r.findingId, citationValid: citationValid.get(r.findingId)! });
            }
        }
        else if (r.outcome === 'duplicate') {
            const target = byReview.get(r.duplicateOf);
            if (r.duplicateOf === r.findingId || !target || target.outcome === 'duplicate')
                throw new Error('Duplicate requires a reviewed original');
        }
        else if (r.outcome === 'addition') {
            if (!r.evidence.every(evidenceValid))
                throw new Error('Unsupported addition evidence');
        }
        else if (r.outcome === 'specificity_failure') {
            unique(r.goldIds);
            if (r.goldIds.some(id => !byGold.has(id)))
                throw new Error('Unknown specificity gold');
        }
    }
    /** Empty ratios are explicitly undefined rather than perfect. */
    const ratio = (numerator: number, denominator: number): ScoreRatio => ({ numerator, denominator, percent: denominator ? numerator / denominator * 100 : null });
    const pending = findings.filter(f => !byReview.has(f.id)).map(f => f.id);
    const ids = (outcome: HumanJudgment['outcome']) => records.filter(r => r.outcome === outcome).map(r => r.findingId);
    return structuredClone({
        identity,
        provisional: gold.review.status !== 'approved' || pending.length > 0,
        contentRecall: ratio(recovered.length, gold.items.length),
        citationValidity: ratio([...citationValid.values()].filter(Boolean).length, findings.length),
        contentWithCitation: ratio(recovered.filter(r => r.citationValid).length, gold.items.length),
        omissions: gold.items.filter(g => !credited.has(g.id)).map(g => g.id),
        parsingLossIds: gold.parsingLossIds,
        pending,
        duplicates: ids('duplicate'),
        additions: ids('addition'),
        unsupported: ids('unsupported'),
        specificityFailures: records.filter(r => r.outcome === 'specificity_failure'),
        items: findings.map(f => ({ findingId: f.id, citationValid: citationValid.get(f.id)!, judgment: byReview.get(f.id) ?? null })),
        recovered,
    });
}
