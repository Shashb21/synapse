/** Readable evaluator-only analysis. No I/O, provider calls or adoption policy. */
import type { BatchResult, BatchRun } from './batch';
import type { FrozenReferencePack } from './inputs';
import type { ScoreRatio } from './scoring';

export type BenchmarkReportInput = {
  result: BatchResult;
  packs: readonly FrozenReferencePack[];
  ceilingUsd: number;
  /** Explicit caller attestation: tests must say synthetic. Omitted is unverified. */
  evidenceKind?: 'live' | 'synthetic';
  /** Preparation/protocol/completeness prerequisites unresolved outside batch. */
  blockers?: readonly string[];
};
export type BenchmarkReport = { status: 'completed' | 'incomplete'; blockers: string[]; markdown: string };
function text(value: unknown): string {
  return String(value ?? 'unknown').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/[\\`*_[\]#|]/g, '\\$&').replace(/\r?\n/g, ' ');
}
function ratio(value?: ScoreRatio): string {
  return value ? `${value.numerator}/${value.denominator} (${value.percent === null ? 'undefined' : `${value.percent.toFixed(2)}%`})` : 'unknown (not scored)';
}
function sourceAnchor(packIndex: number, blockIndex: number): string { return `source-${packIndex}-${blockIndex}`; }
/** Render all saved evidence without recalculating human semantic judgments.
 * Completion requires an explicitly live, complete two-pack 24-run matrix plus
 * batch eligibility, reviewed gold/judgments, valid citations and reconciled costs.
 * Throws on ambiguous pack/run identities, invalid repetition or invalid ceiling.
 * Returns an incomplete readable report even with zero runs/pending preparation.
 * The caller must persist only in Git-excluded private storage; source text is included.
 */
export function renderBenchmarkReport(input: BenchmarkReportInput): BenchmarkReport {
  const { result, packs, ceilingUsd } = input;
  if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) throw new Error('Invalid budget ceiling');
  if (new Set(packs.map(p => p.packId)).size !== packs.length) throw new Error('Duplicate pack identity');
  const keys = new Set<string>();
  const blockers = [...input.blockers ?? [], ...result.reasons];
  const key = (r: Pick<BatchRun, 'packId' | 'stage' | 'configuration' | 'repetition'>) => `${r.packId} / ${r.stage} / ${r.configuration} / repeat ${r.repetition}`;
  for (const run of result.runs) {
    if (!packs.some(p => p.packId === run.packId)) throw new Error('Unknown run pack');
    if (!['need_extract', 'inventory_extract'].includes(run.stage) || !['baseline', 'extract'].includes(run.configuration) || ![1, 2, 3].includes(run.repetition)) throw new Error('Invalid scored matrix identity');
    if (keys.has(key(run)) || result.runs.filter(r => r.id === run.id).length !== 1) throw new Error('Duplicate run identity');
    keys.add(key(run));
    if (run.extraction?.status !== 'completed') blockers.push(`${run.id}: extraction ${run.extraction?.status ?? 'not started'}`);
    if (run.extraction?.actualRoute.label !== 'verified') blockers.push(`${run.id}: responding identity unverified/substituted`);
    if (!run.score || run.score.provisional || !run.auditScore || run.auditScore.provisional || !run.reviewVerified) blockers.push(`${run.id}: human review pending`);
    if (!run.audit?.complete) blockers.push(`${run.id}: incomplete audit`);
    if (run.score && run.score.citationValidity.numerator !== run.score.citationValidity.denominator) blockers.push(`${run.id}: invalid source citations`);
  }
  if (packs.length !== 2) blockers.push('Agreed two-pack matrix missing');
  for (const pack of packs) {
    if (Object.values(pack.gold).some(g => g.review.status !== 'approved')) blockers.push(`${pack.packId}: approved frozen gold pending`);
    for (const stage of ['need_extract', 'inventory_extract'] as const) for (const configuration of ['baseline', 'extract'] as const) for (const repetition of [1, 2, 3]) {
      const identity = { packId: pack.packId, stage, configuration, repetition };
      if (!keys.has(key(identity))) blockers.push(`Missing run: ${key(identity)}`);
    }
  }
  if (result.status !== 'completed') blockers.push('Batch execution/review incomplete');
  if (input.evidenceKind !== 'live') blockers.push(input.evidenceKind === 'synthetic' ? 'Synthetic software checks are not real performance evidence; live agreed matrix pending' : 'Live execution provenance not attested; empirical benchmark pending');
  if (result.costs.unknown) blockers.push('Unreconciled costs: unknown is not zero');
  if (result.costs.reservedUsd > 0 || result.costs.remainingWorkUsd > 0) blockers.push('Reserved costs or planned paid work remain unreconciled');
  if (!Number.isFinite(result.costs.conservativeTotalUsd) || result.costs.conservativeTotalUsd > ceilingUsd) blockers.push('Whole-experiment budget not reconciled within ceiling');
  const uniqueBlockers = [...new Set(blockers)];
  const status = uniqueBlockers.length ? 'incomplete' : 'completed';
  const lines = [`# Benchmark ${text(result.batchId)}`, '', `Status: **${status}**. Batch software status: ${result.status}. Evidence: ${input.evidenceKind ?? 'unverified'}.`, '',
    `${result.runs.filter(r => r.extraction?.status === 'completed').length}/${packs.length * 12} completed extractions; agreed design: two separate decks × two stages × two configurations × three repetitions.`, '',
    'Performance applies only to these reference decks. Human decides adoption and deployment. No recall/speed threshold or automatic recommendation is applied.', '',
    '## Completion blockers', '', ...uniqueBlockers.map(b => `- ${text(b)}`), ...(uniqueBlockers.length ? [] : ['None.']), '',
    '## Whole-experiment costs and time', '',
    `Known charged subtotal $${result.costs.spentUsd}; reserved $${result.costs.reservedUsd}; remaining work $${result.costs.remainingWorkUsd}; conservative total $${result.costs.conservativeTotalUsd}; ceiling $${ceilingUsd}. Unknown billing: ${result.costs.unknown}.`, '',
    `Setup $${result.costs.overheadCharges.setupUsd ?? 'unknown'}; tuning $${result.costs.overheadCharges.tuningUsd ?? 'unknown'}; total elapsed ${result.elapsedMs} ms (including retries/resumes).`, '',
    'Job costs are cumulative; shared parse IDs must be deduplicated. Attempt costs below are not additive to job totals.', ''];
  for (const entry of result.costs.entries) lines.push(`- ${text(entry.runId)} / ${text(entry.id)} / ${text(entry.operation)}: ${text(entry.status)}, cost $${entry.costUsd ?? 'unknown'}, bound $${entry.boundUsd}; job ${text(entry.jobId)}; usage ${text(JSON.stringify(entry.usage))}`);
  for (const job of result.costs.jobs) lines.push(`- Job ${text(job.jobId)}: $${job.costUsd ?? 'unknown'}, parse ${text(job.parseJobId)} $${job.parseUsd ?? 'unknown'}, billing complete ${job.complete}`);
  const sourceLinks = (pack: FrozenReferencePack, ids: string[]) => ids.map(id => {
    const pi = packs.indexOf(pack), bi = pack.source.blocks.findIndex(b => b.id === id);
    return bi < 0 ? `${text(id)} (source block missing)` : `[${text(pack.packId)} / ${text(id)}](#${sourceAnchor(pi, bi)})`;
  }).join(', ');
  for (const pack of packs) {
    lines.push('', `## Deck ${text(pack.packId)}`, '', `Source ${text(pack.sourceHash)}; original ${text(pack.originalFileHash)}; reference ${text(pack.referenceVersion)} / ${text(pack.referenceHash)}; pack ${text(pack.packHash)}; parser ${text(pack.parserVersion)}; code ${text(pack.sourceCodeVersion)}; frozen ${text(pack.frozenAt)}.`, '');
    for (const stage of ['need_extract', 'inventory_extract'] as const) for (const configuration of ['baseline', 'extract'] as const) {
      const runs = result.runs.filter(r => r.packId === pack.packId && r.stage === stage && r.configuration === configuration).sort((a, b) => a.repetition - b.repetition);
      const gold = pack.gold[stage === 'need_extract' ? 'needs' : 'tactics'];
      lines.push(`### ${stage} / ${configuration}`, '', `Gold review: ${text(JSON.stringify(gold.review))}. Overall gold denominator: ${gold.items.length}; parsing losses stay included.`, '',
        '| Run / repeat | Content recall | Citation validity | Content with valid citation | Review | Extraction ms | Audit ms |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const r of runs) lines.push(`| ${text(r.id)} / ${r.repetition} | ${ratio(r.score?.contentRecall)} | ${ratio(r.score?.citationValidity)} | ${ratio(r.score?.contentWithCitation)} | ${!r.reviewVerified || !r.score || r.score.provisional ? 'provisional' : 'human approved'} | ${r.extractionElapsedMs} | ${r.auditAttempts.reduce((n, a) => n + a.elapsedMs, 0)} |`);
      const values = runs.flatMap(r => r.score?.contentRecall.percent == null ? [] : [r.score.contentRecall.percent]);
      lines.push('', `Repeat variation: ${values.length ? `${Math.min(...values).toFixed(2)}–${Math.max(...values).toFixed(2)}%` : 'unknown'} content recall; ${runs.filter(r => r.score).length}/3 scored repetitions. Provisional scores remain provisional.`, '', 'Recurring misses (observed scored runs, not inferred for missing runs):');
      for (const g of gold.items) { const misses = runs.filter(r => r.score?.omissions.includes(g.id)).length; if (misses) lines.push(`- ${text(g.id)}: ${misses}/${runs.filter(r => r.score).length}; ${text(g.statement)}; ${sourceLinks(pack, g.blockIds) || `parsing loss at ${text(JSON.stringify(g.parsingLoss?.location))}`}`); }
      for (const run of runs) {
        lines.push('', `#### Run ${text(run.id)}`, '', `Requested extraction: ${text(JSON.stringify({ provider: run.route.providerId, model: run.route.requestedModel, version: run.route.version, tier: run.route.tier, settingsHash: run.route.settingsHash }))}. Responding: ${text(JSON.stringify(run.extraction?.actualRoute ?? null))}. Status: ${run.extraction?.status ?? 'not started'}; retry used: ${run.retryUsed}.`, '');
        const attempts = [...run.extractionHistory.flatMap(e => e.attempts), ...run.extraction?.attempts ?? [], ...run.extractionState?.attempts ?? []];
        for (const a of [...new Map(attempts.map(a => [a.id, a])).values()]) lines.push(`- Extraction attempt ${text(a.id)}: ${a.status}; started ${text(a.startedAt)}; ${a.elapsedMs} ms; HTTP ${a.httpStatus ?? 'unknown'}; actual ${text(JSON.stringify(a.actualRoute))}; failure ${text(JSON.stringify(a.error))}`);
        if (run.extraction?.error) lines.push(`Failure: ${text(JSON.stringify(run.extraction.error))}`);
        const score = run.score;
        if (!score) lines.push('Metrics and examples pending extraction/human review.');
        else {
          for (const id of score.omissions) { const g = gold.items.find(g => g.id === id); lines.push(`- omission ${text(id)}: ${text(g?.statement)}; ${sourceLinks(pack, g?.blockIds ?? [])}`); }
          for (const id of score.parsingLossIds) { const g = gold.items.find(g => g.id === id); lines.push(`- parsing_loss ${text(id)}: ${text(g?.statement)}; ${text(g?.parsingLoss?.reason)} at ${text(JSON.stringify(g?.parsingLoss?.location))}; absent from parsed source, retained in denominator.`); }
          const categories = [...score.additions.map(id => ['addition', id]), ...score.duplicates.map(id => ['duplicate', id]), ...score.unsupported.map(id => ['unsupported', id]), ...score.specificityFailures.map(j => ['specificity_failure', j.findingId]), ...score.pending.map(id => ['pending', id]), ...score.recovered.map(r => ['recovered', r.findingId])];
          for (const [kind, id] of categories) {
            const f = run.extraction?.findings.find(f => f.id === id), judgment = score.items.find(i => i.findingId === id)?.judgment;
            const specificity = score.specificityFailures.find(j => j.findingId === id);
            lines.push(`- ${kind} ${text(id)}: ${text(f?.statement)}; ${sourceLinks(pack, f?.provenance.map(p => p.block_id) ?? [])}; quotes ${text(JSON.stringify(f?.provenance))}; citation ${f?.citation.valid ?? 'unknown'} / ${text(JSON.stringify(f?.citation.reasons))}; judgment ${text(JSON.stringify(specificity ?? judgment))}`);
          }
        }
        lines.push('', `Audit (separate; warnings never increase extraction recall): requested ${text(JSON.stringify({ provider: run.auditRoute.providerId, model: run.auditRoute.requestedModel, version: run.auditRoute.version, tier: run.auditRoute.tier, settingsHash: run.auditRoute.settingsHash }))}; complete ${run.audit?.complete ?? false}; review ${run.auditScore?.provisional === false && run.reviewVerified ? 'human approved' : 'provisional'}.`, '',
          `Genuine omissions flagged: ${text(JSON.stringify(run.auditScore?.genuineOmissionsFlagged))}; missed omissions: ${text(JSON.stringify(run.auditScore?.missedOmissions))}; incorrect flags: ${text(JSON.stringify(run.auditScore?.incorrectFlags))}.`);
        for (const a of run.auditAttempts) lines.push(`- Audit attempt ${text(a.id)}: ${a.status}; started ${text(a.startedAt)}; actual ${text(JSON.stringify(a.actual))}; ${a.elapsedMs} ms; HTTP ${a.httpStatus ?? 'unknown'}; failure ${text(a.error)}`);
        for (const v of run.audit?.verdicts ?? []) lines.push(`- Audit verdict: ${sourceLinks(pack, [v.block_id])}; ${text(JSON.stringify(v))}; human ${text(JSON.stringify(run.review?.audit.flags.find(f => f.blockId === v.block_id)))}`);
      }
      const mean = (values: number[]) => values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : 'unknown';
      const comparison = (['baseline', 'extract'] as const).map(candidate => {
        const rs = result.runs.filter(r => r.packId === pack.packId && r.stage === stage && r.configuration === candidate);
        const extractionTimes = rs.filter(r => r.extraction !== undefined || r.extractionHistory.length > 0 || (r.extractionState?.attempts.length ?? 0) > 0).map(r => r.extractionElapsedMs);
        const auditTimes = rs.filter(r => r.audit?.complete || r.auditAttempts.some(a => a.status !== 'started')).map(r => r.auditAttempts.reduce((n, a) => n + a.elapsedMs, 0));
        return `${candidate}: mean observed content recall ${mean(rs.flatMap(r => r.score?.contentRecall.percent == null ? [] : [r.score.contentRecall.percent]))}%, citation intersection ${mean(rs.flatMap(r => r.score?.contentWithCitation.percent == null ? [] : [r.score.contentWithCitation.percent]))}%, extraction ${mean(extractionTimes)} ms (n=${extractionTimes.length}), audit ${mean(auditTimes)} ms (n=${auditTimes.length}) (${rs.filter(r => r.score).length}/3 scored runs)`;
      }).join('; ');
      lines.push('', `Advisory tradeoffs for ${stage}: ${comparison}. Compare concrete recurring misses, specificity, audit usefulness and reconciled costs above; missing/unreviewed runs limit the means. ${status === 'completed' ? 'This evidence is limited to these reference decks.' : 'Evidence is incomplete; no empirical adoption conclusion is available.'} Human decides adoption.`, '');
    }
  }
  lines.push('## Source block references', '', 'Private frozen parsed-source excerpts below retain block identity/location. Inspect originals for parsing losses; a page label alone is not valid citation evidence.', '');
  packs.forEach((p, pi) => p.source.blocks.forEach((b, bi) => {
    // Only cited/gold/audit blocks are relevant; avoid reproducing every large deck.
    const referenced = Object.values(p.gold).some(g => g.items.some(i => i.blockIds.includes(b.id))) || result.runs.some(r => r.packId === p.packId && (r.extraction?.findings.some(f => f.provenance.some(s => s.block_id === b.id)) || r.audit?.verdicts.some(v => v.block_id === b.id)));
    if (referenced) lines.push(`<a id="${sourceAnchor(pi, bi)}"></a>`, '', `### ${text(p.packId)} / ${text(b.id)}`, '', `Location: ${text(JSON.stringify(b.location))}`, '', text(b.text), '');
  }));
  return { status, blockers: uniqueBlockers, markdown: lines.join('\n') + '\n' };
}
