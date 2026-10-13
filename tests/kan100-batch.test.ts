import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile, mkdir, symlink, stat, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { runBenchmarkBatch, type BatchServices } from '@/accuracy/eval/benchmark/batch';
import { artifactDigest } from '@/accuracy/eval/benchmark/artifacts';
import { FROZEN_AUDIT_PROCESS_HASH } from '@/accuracy/eval/benchmark/audit';
import { freezeReferencePack } from '@/accuracy/eval/benchmark/inputs';
import { scoringIdentity } from '@/accuracy/eval/benchmark/scoring';
import { checkPreflight } from '@/accuracy/eval/benchmark/preflight';
import type { BenchmarkConfig, BenchmarkRoute } from '@/accuracy/eval/benchmark/contracts';
const root = '/private/tmp/synapse-kan100';
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const stages = ['need_extract', 'inventory_extract'] as const;
async function fixture(singleDeck = false) {
  const batchId = `test-${randomUUID()}`, storage = `data/runtime/benchmark/${batchId}`;
  cleanup.push(path.join(root, storage));
  const bytes = Buffer.from('synthetic-only');
  const sources = (singleDeck ? ['deck-a'] : ['deck-a', 'deck-b']).map(packId => ({ packId, hash: createHash('sha256').update(bytes).digest('hex'), blocks: 2, inputTokens: 100, complete: true, synthetic: true }));
  const config: BenchmarkConfig = { batchId, sourceCodeVersion: 'code', referenceVersion: 'v1', goldReviewed: true, repetitions: 3, blockCap: null, storage: { path: storage, isolated: true, gitIgnored: true, exclusionEvidence: 'required runtime check' }, sources, baselineSnapshot: null, schemaHash: 'schema', promptsHash: 'prompts', auditProcessHash: FROZEN_AUDIT_PROCESS_HASH, routes: [], budget: { ceilingUsd: 10, spentUsd: 0, pendingCost: false, setupUsd: 0, tuningUsd: 0, priceAsOf: '2026-10-13', priceSource: 'synthetic dated bounds', sizeBasisHash: sources.map(s => s.hash).join(','), calls: [{ label: 'all', count: 500, maxUsd: 0.01 }] }, maxTemporaryRetries: 1 };
  const baselines = Object.fromEntries(stages.map(stage => [stage, { snapshot: { call_kind: stage, role: 'proposer' as const, provider_id: 'xai-grok', model: 'frozen-model', params: { temperature: 0, max_tokens: 100 }, fallbacks: [], degraded: false, reason: null }, shallowCycle: false, baseUrl: 'https://api.x.ai/v1' }])) as unknown as BatchServices['baselines'];
  config.baselineSnapshot = artifactDigest(baselines);
  const auditSettings = { temperature: 0, max_tokens: 100 };
  config.routes = (['baseline', 'extract'] as const).flatMap(configuration => [...stages, 'completeness_audit' as const].map(stage => ({ configuration, stage, providerId: stage === 'completeness_audit' || configuration === 'baseline' ? 'xai-grok' : 'llamaextract', requestedModel: stage === 'completeness_audit' ? 'audit-model' : configuration === 'baseline' ? 'frozen-model' : 'extract', actualModel: stage === 'completeness_audit' ? 'audit-model' : configuration === 'baseline' ? 'frozen-model' : 'extract', version: stage === 'completeness_audit' ? 'audit-fixed' : configuration === 'baseline' ? 'fixed' : '2.5', tier: 'cost_effective', lowestCostSuitableTierVerified: true, accountVerified: true, versionVerified: true, citationsVerified: true, citationsEnabled: true, authorizationEvidence: 'synthetic', settingsHash: artifactDigest(stage === 'completeness_audit' ? auditSettings : configuration === 'baseline' ? baselines[stage] : { version: '2.5', tier: 'cost_effective', cite_sources: true }), credentialEnvName: 'SYNTHETIC_KEY', fallbackAllowed: false } satisfies BenchmarkRoute)));
  const review = { status: 'approved' as const, reviewerId: 'local-human', reviewedAt: '2026-10-13T12:00:00Z', referenceVersion: 'v1' };
  const packs = await Promise.all(sources.map(s => freezeReferencePack({ packId: s.packId, filename: 'synthetic.txt', originalFile: bytes, config, parserVersion: 'local-v1', frozenAt: '2026-10-13T12:00:00Z', blocks: [{ id: 'b1', kind: 'paragraph', text: 'older patient evidence study', location: { kind: 'page', ref: '1' } }, { id: 'b2', kind: 'paragraph', text: 'renal impairment need', location: { kind: 'page', ref: '2' } }], gold: { needs: [{ id: 'need-gold', statement: 'older patient evidence', blockIds: ['b1'] }, { id: 'renal-gold', statement: 'renal impairment', blockIds: ['b2'] }], tactics: [{ id: 'tactic-gold', statement: 'older patient study', blockIds: ['b1'] }], needsReview: review, tacticsReview: review } })));
  let ordinal = 0;
  const jobs = new Map<string, { stage: string; packId: string; file: string }>();
  const uploads = new Map<string, string>();
  const data = (stage: string, packId: string) => stage === 'need_extract' ? { gaps: [{ statement: 'older patient evidence', provenance: [{ source_file_id: packId, block_id: 'b1', quote: 'older patient evidence study' }] }] } : { tactics: [{ name: 'older patient evidence study', type: 'rwe_study', status: 'planned', evidence_question: 'older patient evidence', origin: 'inventory', provenance: [{ source_file_id: packId, block_id: 'b1', quote: 'older patient evidence study' }] }] };
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/beta/files')) { const text = await ((init!.body as FormData).get('file') as Blob).text(); const id = `file-${++ordinal}`; uploads.set(id, text.match(/source_file_id=(\S+)/)![1]); return Response.json({ id }); }
    if (u.includes('/api/v2/extract')) {
      let id: string;
      if (init!.method === 'POST') { const body = JSON.parse(init!.body as string); id = `job-${++ordinal}`; jobs.set(id, { stage: body.configuration.data_schema.properties.gaps ? 'need_extract' : 'inventory_extract', packId: uploads.get(body.file_input)!, file: body.file_input }); }
      else id = u.split('/extract/')[1].split('?')[0];
      const j = jobs.get(id)!;
      const key = j.stage === 'need_extract' ? 'gaps' : 'tactics';
      return Response.json({ id, file_input: j.file, status: 'COMPLETED', configuration: { version: '2.5', tier: 'cost_effective', cite_sources: true }, extract_result: data(j.stage, j.packId), extract_metadata: { field_metadata: { document_metadata: { [key]: [{ [key === 'gaps' ? 'statement' : 'name']: { citation: [{ matching_text: 'older patient evidence study' }] } }] } } }, usage: { credits: 1, extract_credits: 1, parse_credits: 0 } });
    }
    const body = JSON.parse(init!.body as string), user = body.messages[1].content as string;
    const stage = body.messages[0].content.includes('tactic') && !body.messages[0].content.includes('gaps') ? 'inventory_extract' : body.messages[0].content.includes('inventory') ? 'inventory_extract' : 'need_extract';
    return Response.json({ model: 'frozen-model', choices: [{ message: { content: JSON.stringify(data(stage, user.match(/source_file_id=(\S+)/)![1])) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const services: BatchServices = { root, envNames: ['SYNTHETIC_KEY'], baselines, projectId: 'synthetic-project', auditSettings, pricing: { asOf: config.budget.priceAsOf, source: config.budget.priceSource, baselineMaxUsd: 0.01, extractJobMaxUsd: 0.01, uploadMaxUsd: 0, auditMaxUsd: 0.01, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxPolls: 2, extraction: () => ({ fetch, apiKey: 'synthetic-secret' }), audit: { complete: vi.fn<BatchServices['audit']['complete']>(async request => ({ raw: { verdicts: request.blockIds.map(block_id => ({ block_id, missed: true, claim_type: 'gap', rationale: '=synthetic warning' })) }, providerId: request.route.providerId, model: request.route.requestedModel, settingsHash: request.route.settingsHash, usage: { input_tokens: 10, output_tokens: 5 } })) }, human: async ({ run, pack }) => ({ extraction: { identity: scoringIdentity(pack, run.stage, run.extraction!.findings), records: run.extraction!.findings.map(f => ({ findingId: f.id, reviewerId: 'human', reviewedAt: '2026-10-13T13:00:00Z', signature: 'local attestation', rationale: 'Checked meaning and quote', outcome: 'match' as const, meanings: [{ goldId: run.stage === 'need_extract' ? 'need-gold' : 'tactic-gold', essentialMeaning: 'older patient evidence' }] })) }, audit: { flags: run.audit!.flags.map(f => ({ blockId: f.block_id, goldIds: run.stage === 'need_extract' ? ['renal-gold'] : [], incorrect: run.stage !== 'need_extract', rationale: 'Human checked flag against source' })) } }), verifyReview: async () => true };
  return { config, packs, services, fetch };
}
describe('restart-safe isolated full batch', () => {
  it('persists a separate complete matrix, human scores, audit, costs, raw attempts and safe CSV', async () => {
    const f = await fixture();
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.reasons).toEqual([]); expect(result.status).toBe('completed');
    expect(result.runs).toHaveLength(24);
    expect(result.runs.every(r => r.score?.contentRecall.denominator === (r.stage === 'need_extract' ? 2 : 1))).toBe(true);
    expect(result.runs.filter(r => r.stage === 'need_extract').every(r => r.auditScore?.genuineOmissionsFlagged.includes('renal-gold'))).toBe(true);
    expect(result.costs.unknown).toBe(false);
    expect(await readFile(path.join(root, f.config.storage.path, 'final.json'), 'utf8')).not.toContain('synthetic-secret');
    expect(await readFile(path.join(root, f.config.storage.path, 'findings.csv'), 'utf8')).toContain("'=synthetic warning");
  });
  it('keeps signed but unauthenticated review provisional and reuses outputs for full-matrix review', async () => {
    const f = await fixture(); delete f.services.verifyReview;
    const interim = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(interim.status).toBe('incomplete'); expect(interim.runs.every(r => r.score?.provisional)).toBe(true);
    const calls = f.fetch.mock.calls.length;
    const done = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: interim.checkpointDigest, verifyReview: async () => true });
    expect(done.status).toBe('completed'); expect(f.fetch).toHaveBeenCalledTimes(calls);
  });
  it('resumes existing jobs with bounded polls and reconciles cumulative/shared parse billing once', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    let queued = true;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).includes('/api/v2/extract')) return response;
      const payload = await response.json();
      payload.usage = { credits: 3, extract_credits: 1, parse_credits: 2, parse_job_id: 'shared-parse' };
      if (queued) payload.status = 'RUNNING';
      return Response.json(payload);
    });
    const interim = await runBenchmarkBatch(f.config, f.packs, { ...f.services, maxPolls: 2 });
    expect(interim.status).toBe('incomplete');
    expect(interim.runs.filter(r => r.configuration === 'extract').every(r => r.polls === 2)).toBe(true);
    expect(interim.costs.jobs).toHaveLength(6);
    expect(interim.costs.spentUsd).toBeCloseTo(6 * 0.00125 + 0.0025 + 12 * 0.00002);
    queued = false;
    const calls = f.fetch.mock.calls.length;
    const resumed = await runBenchmarkBatch(f.config, f.packs, { ...f.services, maxPolls: 2, resumeDigest: interim.checkpointDigest });
    expect(resumed.status).toBe('incomplete');
    expect(f.fetch).toHaveBeenCalledTimes(calls); // lifetime poll limit is never reset by restarting
  });
  it('retains pending jobs across interruption and polls the same job without upload or submit replay', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    let breakOnPoll = true;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).includes('/api/v2/extract')) return response;
      const payload = await response.json();
      if (init?.method === 'POST') payload.status = 'RUNNING';
      if (init?.method === 'GET' && breakOnPoll) return Response.json({ usage: { credits: 1, extract_credits: 1, parse_credits: 0 } }, { status: 503 });
      return Response.json(payload);
    });
    const interim = await runBenchmarkBatch(f.config, f.packs, f.services);
    const submits = f.fetch.mock.calls.filter(([url, init]) => String(url).includes('/api/v2/extract') && init?.method === 'POST').length;
    breakOnPoll = false;
    const result = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: interim.checkpointDigest });
    expect(result.reasons).toEqual([]); expect(result.status).toBe('completed');
    expect(f.fetch.mock.calls.filter(([url, init]) => String(url).includes('/api/v2/extract') && init?.method === 'POST')).toHaveLength(submits);
    expect(result.runs.filter(r => r.configuration === 'extract').every(r => r.polls === 2)).toBe(true);
  });
  it('rejects changed source bytes, configuration, checkpoint records and absent trusted resume digest', async () => {
    const f = await fixture(true);
    const changed = structuredClone(f.packs); changed[0].source.blocks[0].text = 'altered';
    await expect(runBenchmarkBatch(f.config, changed, f.services)).rejects.toThrow('identity/content');
    expect(f.fetch).not.toHaveBeenCalled();
    const interim = await runBenchmarkBatch(f.config, f.packs, { ...f.services, verifyReview: undefined });
    await expect(runBenchmarkBatch(f.config, f.packs, f.services)).rejects.toThrow('resume digest');
    await expect(runBenchmarkBatch({ ...f.config, promptsHash: 'changed' }, f.packs, { ...f.services, resumeDigest: interim.checkpointDigest })).rejects.toThrow('configuration changed');
    const filename = path.join(root, f.config.storage.path, 'manifest.json');
    const saved = JSON.parse(await readFile(filename, 'utf8')); saved.runs[0].extraction.findings[0].statement = 'private JSON altered';
    await writeFile(filename, JSON.stringify(saved));
    await expect(runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: interim.checkpointDigest })).rejects.toThrow('contents changed');
  });
  it('allows one labelled temporary retry, prices every attempt and never retries low recall', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    let failed = false;
    f.fetch.mockImplementation(async (url, init) => {
      if (!String(url).includes('llamaindex') && !failed) { failed = true; return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, { status: 503 }); }
      return original(url, init);
    });
    const done = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(done.status).toBe('completed');
    expect(done.runs.filter(r => r.retryUsed)).toHaveLength(1);
    expect(done.runs[0].extractionHistory).toHaveLength(1);
    expect(done.costs.entries.filter(e => e.operation === 'baseline')).toHaveLength(7);
    expect(done.runs[0].score?.contentRecall.percent).toBe(50);
    expect(done.costs.entries.filter(e => e.operation === 'baseline').every(e => e.costUsd === 0.00002)).toBe(true);
  });
  it('stops all calls when a known charge exceeds its bound, including before a shallow revision', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    for (const stage of stages) f.services.baselines[stage].shallowCycle = true;
    f.config.baselineSnapshot = artifactDigest(f.services.baselines);
    for (const route of f.config.routes) if (route.configuration === 'baseline' && route.stage !== 'completeness_audit') route.settingsHash = artifactDigest(f.services.baselines[route.stage]);
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init), payload = await response.json();
      if (!String(url).includes('llamaindex')) {
        payload.usage = { prompt_tokens: 1e8, completion_tokens: 5 };
        const data = JSON.parse(payload.choices[0].message.content); data.gaps[0].provenance = []; payload.choices[0].message.content = JSON.stringify(data);
      }
      return Response.json(payload);
    });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.status).toBe('incomplete'); expect(result.reasons.join(' ')).toContain('unexpected charge');
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.services.audit.complete).not.toHaveBeenCalled();
  });
  it('preserves bounded unknown billing and rejects unaffordable full-work/revision plans before calls', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init), payload = await response.json();
      if (!String(url).includes('llamaindex')) delete payload.usage;
      return Response.json(payload);
    });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.costs.unknown).toBe(true); expect(result.costs.reservedUsd).toBeCloseTo(0.06);
    expect(result.status).toBe('incomplete');
    const g = await fixture(true); g.services.pricing.baselineMaxUsd = 2;
    await expect(runBenchmarkBatch(g.config, g.packs, g.services)).rejects.toThrow('reservations exceed ceiling');
    expect(g.fetch).not.toHaveBeenCalled();
  });
  it('exclusive ownership blocks a second worker and verifies private permissions and real exclusion', async () => {
    const f = await fixture(true);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementationOnce(async (url, init) => { entered(); await gate; return original(url, init); });
    const worker = runBenchmarkBatch(f.config, f.packs, f.services);
    await ready;
    try { await expect(runBenchmarkBatch(f.config, f.packs, f.services)).rejects.toMatchObject({ code: 'EEXIST' }); }
    finally { release(); }
    const result = await worker;
    expect(result.status).toBe('completed');
    expect((await stat(path.join(root, f.config.storage.path))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, f.config.storage.path, 'manifest.json'))).mode & 0o777).toBe(0o600);
    const otherRoot = await mkdtemp('/tmp/kan105-no-git-'); cleanup.push(otherRoot);
    await expect(runBenchmarkBatch(f.config, f.packs, { ...f.services, root: otherRoot })).rejects.toThrow();
  });
  it('rejects storage symlink traversal before source artifacts are written', async () => {
    const f = await fixture(true), destination = path.join(root, 'data/runtime', `target-${randomUUID()}`);
    cleanup.push(destination); await mkdir(destination); await mkdir(path.dirname(path.join(root, f.config.storage.path)), { recursive: true });
    await symlink(destination, path.join(root, f.config.storage.path));
    await expect(runBenchmarkBatch(f.config, f.packs, f.services)).rejects.toThrow(/Symlink|symbolic link/);
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(readFile(path.join(destination, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses exactly the same audit route/settings/process and keeps extraction version separate', async () => {
    const f = await fixture(true);
    expect(checkPreflight(f.config, f.services.envNames).ready).toBe(true);
    const changed = structuredClone(f.config); changed.routes.find(r => r.stage === 'completeness_audit' && r.configuration === 'extract')!.settingsHash = 'different';
    expect(checkPreflight(changed, f.services.envNames).ready).toBe(false);
    await expect(runBenchmarkBatch(changed, f.packs, f.services)).rejects.toThrow('same frozen audit');
    const original = f.services.audit.complete;
    f.services.audit.complete = vi.fn(async request => { expect(JSON.stringify(request)).not.toContain('renal-gold'); expect(request.route.version).toBe('audit-fixed'); return original(request); });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.status).toBe('completed');
    for (const stage of stages) {
      const runs = result.runs.filter(r => r.stage === stage && r.repetition === 1);
      expect(runs[0].audit!.chunks).toEqual(runs[1].audit!.chunks);
      expect(runs[0].score!.contentRecall.numerator).toBe(1);
    }
    expect(result.runs.filter(r => r.stage === 'inventory_extract').every(r => r.auditScore?.incorrectFlags.includes('b2'))).toBe(true);
  });
  it('authenticates review records as well as identity and rescales the entire corrected reference without paid reruns', async () => {
    const f = await fixture(true), approvals = new Set<string>();
    f.services.verifyReview = async request => { approvals.add(request.digest); return true; };
    const old = await runBenchmarkBatch(f.config, f.packs, f.services), calls = f.fetch.mock.calls.length;
    f.services.verifyReview = async request => approvals.has(request.digest);
    const originalHuman = f.services.human!;
    f.services.human = async request => { const review = (await originalHuman(request))!; review.extraction.records[0].rationale = 'Changed record under same identity'; return review; };
    const altered = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: old.checkpointDigest });
    expect(altered.status).toBe('incomplete'); expect(altered.runs.every(r => !r.reviewVerified)).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
    const config = { ...f.config, referenceVersion: 'v2' };
    const packs = f.packs.map(pack => {
      const next = structuredClone(pack); next.referenceVersion = 'v2';
      for (const gold of Object.values(next.gold)) { if (gold.review.status === 'approved') gold.review.referenceVersion = 'v2'; }
      next.gold.needs.items.push({ id: 'corrected-gold', statement: 'another reviewed need', blockIds: ['b2'] });
      next.referenceHash = artifactDigest({ packId: next.packId, referenceVersion: next.referenceVersion, gold: next.gold });
      const { packHash: _hash, ...payload } = next; void _hash; next.packHash = artifactDigest(payload); return next;
    });
    const corrected = await runBenchmarkBatch(config, packs, { ...f.services, resumeDigest: altered.checkpointDigest, referenceCorrection: { rationale: 'Reviewed missing gold row', reviewerId: 'human', reviewedAt: '2026-10-13T14:00:00Z' }, verifyReview: async () => true });
    expect(corrected.status).toBe('completed'); expect(f.fetch).toHaveBeenCalledTimes(calls);
    expect(corrected.runs.every(r => r.score?.identity.referenceVersion === 'v2')).toBe(true);
    expect(corrected.runs.filter(r => r.stage === 'need_extract').every(r => r.score?.contentRecall.denominator === 3)).toBe(true);
    const saved = JSON.parse(await readFile(path.join(root, config.storage.path, 'manifest.json'), 'utf8'));
    expect(saved.history).toHaveLength(1); expect(saved.history[0].evaluations).toHaveLength(12); expect(saved.history[0].packs[0].referenceVersion).toBe('v1');
  });

  it('never replays an interrupted potentially charged baseline, or an uncertain Extract submission', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (!String(url).includes('llamaindex')) throw new Error('uncertain connection');
      if (String(url).includes('/api/v2/extract') && init?.method === 'POST') throw new Error('uncertain submission');
      return original(url, init);
    });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services), calls = f.fetch.mock.calls.length;
    expect(result.status).toBe('incomplete'); expect(result.costs.unknown).toBe(true);
    expect(result.runs.every(r => !r.retryUsed)).toBe(true);
    const resumed = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: result.checkpointDigest });
    expect(resumed.status).toBe('incomplete'); expect(f.fetch).toHaveBeenCalledTimes(calls);
    expect(result.runs.filter(r => r.configuration === 'extract').every(r => r.extractionState?.submissionUncertain)).toBe(true);
  });
  it('records an operation before HTTP and retains it when the durable checkpoint is interrupted', async () => {
    const f = await fixture(true);
    let digest = '', broke = false;
    const filename = path.join(root, f.config.storage.path, 'manifest.json');
    const services = { ...f.services, onCheckpoint: async (d: string) => {
      digest = d;
      const saved = JSON.parse(await readFile(filename, 'utf8'));
      if (!broke && saved.costs.some((e: { status: string }) => e.status === 'started')) { broke = true; throw new Error('checkpoint interrupted'); }
    } };
    // Adapter fails closed even if its beforeAttempt hook never returns.
    const first = await runBenchmarkBatch(f.config, f.packs, services);
    const calls = f.fetch.mock.calls.length;
    expect(first.runs[0].extraction?.status).toBe('blocked');
    expect(first.costs.entries[0].status).toBe('started');
    expect(first.costs.entries[0].costUsd).toBeNull();
    expect(await readFile(path.join(root, f.config.storage.path, 'interim-report.md'), 'utf8')).toContain('incomplete');
    const next = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: digest });
    expect(next.status).toBe('incomplete'); expect(f.fetch).toHaveBeenCalledTimes(calls);
  });
  it('reconciles delayed billing on the same completed job while retaining the extraction findings', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    let billingReady = false;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).includes('/api/v2/extract')) return response;
      const payload = await response.json(); if (!billingReady) delete payload.usage;
      return Response.json(payload);
    });
    const pending = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(pending.status).toBe('incomplete'); expect(pending.costs.unknown).toBe(true);
    expect(pending.runs.every(r => r.extraction?.status === 'completed')).toBe(true);
    const submits = f.fetch.mock.calls.filter(([url, init]) => String(url).includes('/api/v2/extract') && init?.method === 'POST').length;
    billingReady = true;
    const final = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: pending.checkpointDigest });
    expect(final.status).toBe('completed'); expect(final.costs.unknown).toBe(false);
    expect(f.fetch.mock.calls.filter(([url, init]) => String(url).includes('/api/v2/extract') && init?.method === 'POST')).toHaveLength(submits);
    expect(final.runs.map(r => r.extraction?.findings)).toEqual(pending.runs.map(r => r.extraction?.findings));
  });
  it('rejects invalid/missing audit verdicts and substituted responses without inflating recall', async () => {
    const f = await fixture(true);
    f.services.audit.complete = vi.fn(async request => ({ raw: { verdicts: [] }, providerId: request.route.providerId, model: 'substituted-audit', settingsHash: request.route.settingsHash, usage: { input_tokens: 10, output_tokens: 5 } }));
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.status).toBe('incomplete'); expect(result.runs.every(r => !r.audit?.complete)).toBe(true);
    expect(result.runs.filter(r => r.stage === 'need_extract').every(r => r.score?.contentRecall.percent === 50)).toBe(true);
    expect(result.runs.every(r => r.auditAttempts[0].raw)).toBe(true);
    expect(result.costs.entries.filter(e => e.operation === 'audit').every(e => e.costUsd === 0.00002)).toBe(true);
    await expect(readFile(path.join(root, f.config.storage.path, 'final.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shares a single temporary retry allowance between audit and extraction and records failed audit billing', async () => {
    const f = await fixture(true), complete = f.services.audit.complete;
    let once = false;
    f.services.audit.redactValues = ['audit-secret'];
    f.services.audit.complete = vi.fn(async request => {
      if (!once) { once = true; throw { temporary: true, httpStatus: 503, raw: { message: 'audit-secret' }, usage: { input_tokens: 10, output_tokens: 5 } }; }
      return complete(request);
    });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.status).toBe('completed');
    expect(result.runs[0].auditAttempts).toHaveLength(2);
    expect(result.runs[0].auditAttempts[0].status).toBe('failed');
    expect(result.costs.entries.filter(e => e.operation === 'audit')).toHaveLength(13);
    expect(result.costs.entries.filter(e => e.operation === 'audit').every(e => e.costUsd === 0.00002)).toBe(true);
    expect(await readFile(path.join(root, f.config.storage.path, 'final.json'), 'utf8')).not.toContain('audit-secret');
  });

  it('prices both baseline proposer and shallow revision and persists independent call evidence', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    for (const stage of stages) f.services.baselines[stage].shallowCycle = true;
    f.config.baselineSnapshot = artifactDigest(f.services.baselines);
    for (const route of f.config.routes) if (route.configuration === 'baseline' && route.stage !== 'completeness_audit') route.settingsHash = artifactDigest(f.services.baselines[route.stage]);
    let first = true;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).includes('llamaindex') || !first) return response;
      first = false;
      const payload = await response.json(), data = JSON.parse(payload.choices[0].message.content);
      data.gaps[0].provenance = []; payload.choices[0].message.content = JSON.stringify(data);
      return Response.json(payload);
    });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.status).toBe('completed');
    expect(result.runs[0].extraction?.attempts).toHaveLength(2);
    expect(result.runs[0].extraction?.rawOutputs).toHaveLength(2);
    expect(result.costs.entries.filter(e => e.operation === 'baseline')).toHaveLength(7);
    expect(result.costs.entries.filter(e => e.operation === 'baseline').every(e => e.costUsd === 0.00002)).toBe(true);
  });

  it('stops on known partial job charges above the bound even when total billing is missing', async () => {
    const f = await fixture(true), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).includes('/api/v2/extract')) return response;
      const payload = await response.json(); payload.usage = { extract_credits: 100, parse_credits: 0 };
      return Response.json(payload);
    });
    const result = await runBenchmarkBatch(f.config, f.packs, f.services);
    expect(result.status).toBe('incomplete'); expect(result.reasons.join(' ')).toContain('unexpected job charge');
    expect(result.costs.jobs).toHaveLength(1); expect(result.costs.jobs[0].costUsd).toBe(0.125);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).includes('llamaindex'))).toHaveLength(2);
  });

  it('reserves setup/tuning separately from spent costs until explicit overhead reconciliation', async () => {
    const f = await fixture(true); f.config.budget.setupUsd = 0.05; f.config.budget.tuningUsd = 0.02;
    const pending = await runBenchmarkBatch(f.config, f.packs, f.services), calls = f.fetch.mock.calls.length;
    expect(pending.status).toBe('incomplete'); expect(pending.costs.reservedUsd).toBeCloseTo(0.07);
    expect(pending.costs.overheadCharges).toEqual({ setupUsd: null, tuningUsd: null });
    const final = await runBenchmarkBatch(f.config, f.packs, { ...f.services, resumeDigest: pending.checkpointDigest, overheadCharges: { setupUsd: 0.02, tuningUsd: 0 } });
    expect(final.status).toBe('completed'); expect(final.costs.reservedUsd).toBe(0);
    expect(final.costs.spentUsd - pending.costs.spentUsd).toBeCloseTo(0.02); expect(f.fetch).toHaveBeenCalledTimes(calls);
    const g = await fixture(true); g.config.budget.setupUsd = 0.01;
    const stopped = await runBenchmarkBatch(g.config, g.packs, { ...g.services, overheadCharges: { setupUsd: 1, tuningUsd: 0 } });
    expect(stopped.status).toBe('incomplete'); expect(stopped.reasons.join(' ')).toContain('setup/tuning'); expect(g.fetch).not.toHaveBeenCalled();
  });

});
