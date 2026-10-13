import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runBenchmarkCli } from '@/accuracy/eval/benchmark/scripts/kan100-benchmark';
import { freezeReferencePack } from '@/accuracy/eval/benchmark/inputs';
import { artifactDigest } from '@/accuracy/eval/benchmark/artifacts';
import { FROZEN_AUDIT_PROCESS_HASH } from '@/accuracy/eval/benchmark/audit';
import { scoringIdentity } from '@/accuracy/eval/benchmark/scoring';
import type { BenchmarkConfig } from '@/accuracy/eval/benchmark/contracts';
import type { BatchServices, BatchRun } from '@/accuracy/eval/benchmark/batch';

const root = fileURLToPath(new URL('../', import.meta.url));
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const id = `cli-${randomUUID()}`, inputs = `data/runtime/benchmark/inputs-${id}`, storage = `data/runtime/benchmark/${id}`;
  cleanup.push(path.join(root, inputs), path.join(root, storage));
  await mkdir(path.join(root, inputs), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('Synthetic older patients.\nSynthetic renal impairment.');
  const sources = ['synthetic-a', 'synthetic-b'].map(packId => ({ packId, hash: createHash('sha256').update(bytes).digest('hex'), blocks: 2, inputTokens: 50, complete: true, synthetic: true }));
  const baselines = Object.fromEntries(['need_extract', 'inventory_extract'].map(stage => [stage, { snapshot: { call_kind: stage, role: 'proposer', provider_id: 'xai-grok', model: 'synthetic-model', params: { temperature: 0, max_tokens: 100 }, fallbacks: [], degraded: false, reason: null }, shallowCycle: false, baseUrl: 'https://api.x.ai/v1' }])) as unknown as BatchServices['baselines'];
  const auditSettings = { temperature: 0, max_tokens: 100 };
  const config: BenchmarkConfig = { batchId: id, sourceCodeVersion: 'synthetic-code', referenceVersion: 'v1', goldReviewed: true,
    repetitions: 3, blockCap: null, storage: { path: storage, isolated: true, gitIgnored: true, exclusionEvidence: 'runtime boundary verifies' },
    sources, baselineSnapshot: artifactDigest(baselines), schemaHash: 'synthetic-schema', promptsHash: 'synthetic-prompts', auditProcessHash: FROZEN_AUDIT_PROCESS_HASH,
    routes: (['baseline', 'extract'] as const).flatMap(configuration => (['need_extract', 'inventory_extract', 'completeness_audit'] as const).map(stage => ({
      configuration, stage, providerId: stage === 'completeness_audit' || configuration === 'baseline' ? 'xai-grok' : 'llamaextract',
      requestedModel: stage === 'completeness_audit' ? 'synthetic-audit' : configuration === 'baseline' ? 'synthetic-model' : 'extract',
      actualModel: stage === 'completeness_audit' ? 'synthetic-audit' : configuration === 'baseline' ? 'synthetic-model' : 'extract',
      version: stage === 'completeness_audit' ? 'audit-fixed' : configuration === 'baseline' ? 'fixed' : '2.5', tier: 'cost_effective',
      lowestCostSuitableTierVerified: true, accountVerified: true, versionVerified: true, citationsVerified: true, citationsEnabled: true,
      authorizationEvidence: 'Synthetic test only', settingsHash: artifactDigest(stage === 'completeness_audit' ? auditSettings : configuration === 'baseline' ? baselines[stage] : { version: '2.5', tier: 'cost_effective', cite_sources: true }), credentialEnvName: 'CLI_SYNTHETIC_KEY', fallbackAllowed: false,
    }))), budget: { ceilingUsd: 10, spentUsd: 0, pendingCost: false, setupUsd: 0, tuningUsd: 0,
      priceAsOf: '2026-10-13', priceSource: 'synthetic bounded prices', sizeBasisHash: sources.map(s => s.hash).join(','), calls: [{ label: 'every operation', count: 400, maxUsd: 0.01 }] }, maxTemporaryRetries: 1 };
  const runtime = { baselines, auditBaseUrl: 'https://api.x.ai/v1', auditSettings, projectId: 'synthetic', maxPolls: 2,
    pricing: { asOf: config.budget.priceAsOf, source: config.budget.priceSource, baselineMaxUsd: 0.01, extractJobMaxUsd: 0.01, uploadMaxUsd: 0, auditMaxUsd: 0.01, inputUsdPerMillion: 1, outputUsdPerMillion: 1 } };
  const review = { status: 'approved' as const, referenceVersion: 'v1', reviewerId: 'synthetic-human', reviewedAt: '2026-10-13T12:00:00Z' };
  const packs = await Promise.all(sources.map(s => freezeReferencePack({ packId: s.packId, filename: 'synthetic.txt', originalFile: bytes, config,
    frozenAt: '2026-10-13T12:00:00Z', parserVersion: 'synthetic-v1', blocks: [{ id: 'b1', text: 'Synthetic older patients.', kind: 'paragraph', location: { kind: 'page', ref: '1' } }, { id: 'b2', text: 'Synthetic renal impairment.', kind: 'paragraph', location: { kind: 'page', ref: '2' } }],
    gold: { needs: [{ id: 'n1', statement: 'Older patients.', blockIds: ['b1'] }], tactics: [{ id: 't1', statement: 'Study older patients.', blockIds: ['b1'] }], needsReview: review, tacticsReview: review } })));
  const files: Record<string, string> = {};
  const put = async (name: string, value: unknown) => { const p = path.join(inputs, `${name}.json`); await writeFile(path.join(root, p), JSON.stringify(value), { mode: 0o600 }); files[name] = p; return p; };
  await put('config', config); await put('runtime', runtime); await put('packs', packs);
  await put('approvals', packs.map(pack => artifactDigest({ kind: 'gold', pack })));
  files.checkpoint = path.join(inputs, 'checkpoint.json');
  const args = (command: string) => [command, ...['config', 'packs', 'runtime', 'checkpoint', 'approvals'].flatMap(k => [`--${k}`, files[k]])];
  let ordinal = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const u = String(url);
    if (u.includes('/beta/files')) return Response.json({ id: `file-${++ordinal}` });
    if (u.includes('/api/v2/extract')) {
      const body = JSON.parse(init!.body as string);
      const key = body.configuration.data_schema.properties.gaps ? 'gaps' : 'tactics';
      return Response.json({ id: `job-${++ordinal}`, model: 'extract', status: 'COMPLETED', configuration: { version: '2.5', tier: 'cost_effective', cite_sources: true }, extract_result: { [key]: [] }, extract_metadata: { field_metadata: { document_metadata: { [key]: [] } } }, usage: { credits: 1, extract_credits: 1, parse_credits: 0 } });
    }
    const body = JSON.parse(init!.body as string);
    if (body.model === 'synthetic-audit') {
      // Prompt carries JSON block objects. IDs are fixture-owned; answer exactly all uncited blocks.
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ verdicts: ['b1', 'b2'].map(block_id => ({ block_id, missed: false, claim_type: null, rationale: 'Synthetic check.' })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    return Response.json({ model: 'synthetic-model', choices: [{ message: { content: JSON.stringify(body.messages[0].content.includes('tactic') && !body.messages[0].content.includes('gaps') ? { tactics: [] } : { gaps: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const credential = vi.fn(() => 'synthetic-secret');
  const context = { root, envNames: ['CLI_SYNTHETIC_KEY'], credential, fetch };
  return { config, runtime, packs, files, args, context, put, inputs, storage, bytes };
}

describe('explicit isolated CLI', () => {
  it('rejects missing commands without reflecting values', async () => {
    const result = await runBenchmarkCli(['private-secret']);
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('rejects DB environment names before reading any credential values', async () => {
    let reads = 0;
    const result = await runBenchmarkCli(['run'], { envNames: ['DATABASE_URL'], credential: () => { reads++; throw Error('secret'); } });
    expect(result.exitCode).toBe(2);
    expect(reads).toBe(0);
  });
  it('synthetic smoke saves the whole 24-run matrix and honestly returns incomplete review, then imports exact human digests without HTTP', async () => {
    const f = await fixture();
    const smoke = await runBenchmarkCli(f.args('run'), f.context);
    expect(smoke.status).toBe('incomplete'); expect(smoke.exitCode).toBe(2); expect(smoke.runs).toBe(24);
    expect(smoke.reasons?.some(r => r.includes('human review pending'))).toBe(true);
    expect(f.context.credential.mock.calls).toEqual([['CLI_SYNTHETIC_KEY']]);
    const manifest = JSON.parse(await readFile(path.join(root, f.storage, 'manifest.json'), 'utf8'));
    expect(manifest.runs.every((r: BatchRun) => r.extraction?.status === 'completed' && r.audit?.complete)).toBe(true);
    const decisions = Object.fromEntries(manifest.runs.map((r: BatchRun) => [r.id, { extraction: { identity: scoringIdentity(f.packs.find(p => p.packId === r.packId)!, r.stage, r.extraction!.findings), records: [] }, audit: { flags: [] } }]));
    await f.put('decisions', decisions);
    const calls = f.context.fetch.mock.calls.length;
    const imported = await runBenchmarkCli([...f.args('review'), '--decisions', f.files.decisions], f.context);
    expect(imported.exitCode).toBe(2); expect(f.context.fetch).toHaveBeenCalledTimes(calls);
    const requests = JSON.parse(await readFile(path.join(root, f.storage, 'review-requests.json'), 'utf8'));
    expect(requests).toHaveLength(26);
    await f.put('approvals', requests.map((r: { digest: string }) => r.digest));
    const trusted = await readFile(path.join(root, f.files.checkpoint), 'utf8');
    await writeFile(path.join(root, f.files.checkpoint), JSON.stringify('0'.repeat(64)));
    expect((await runBenchmarkCli([...f.args('review'), '--decisions', f.files.decisions], f.context)).exitCode).toBe(2);
    await writeFile(path.join(root, f.files.checkpoint), trusted);
    f.context.credential.mockClear();
    const final = await runBenchmarkCli([...f.args('review'), '--decisions', f.files.decisions], f.context);
    expect(final.exitCode).toBe(0); expect(final.status).toBe('completed');
    expect(f.context.fetch).toHaveBeenCalledTimes(calls); expect(f.context.credential).not.toHaveBeenCalled();
    for (const name of ['final.json', 'interim.json', 'runs.csv', 'findings.csv', 'attempts.csv', 'jobs.csv']) expect(await readFile(path.join(root, f.storage, name), 'utf8')).not.toContain('synthetic-secret');
  });
  it('malformed private config is sanitized without environment or provider work', async () => {
    const f = await fixture();
    await writeFile(path.join(root, f.files.config), '{"secret":"private-value"');
    const result = await runBenchmarkCli(f.args('run'), f.context);
    expect(result.exitCode).toBe(1); expect(JSON.stringify(result)).not.toContain('private-value');
    expect(f.context.credential).not.toHaveBeenCalled(); expect(f.context.fetch).not.toHaveBeenCalled();
  });
  it('uses each explicitly selected audit account for its configuration', async () => {
    const f = await fixture();
    for (const route of f.config.routes.filter(r => r.stage === 'completeness_audit')) {
      route.credentialEnvName = route.configuration === 'baseline' ? 'CLI_BASELINE_AUDIT_KEY' : 'CLI_EXTRACT_AUDIT_KEY';
    }
    await f.put('config', f.config);
    const credentials: Record<string, string> = {
      CLI_SYNTHETIC_KEY: 'synthetic-secret',
      CLI_BASELINE_AUDIT_KEY: 'baseline-audit-secret',
      CLI_EXTRACT_AUDIT_KEY: 'extract-audit-secret',
    };
    const result = await runBenchmarkCli(f.args('run'), {
      ...f.context, envNames: Object.keys(credentials), credential: name => credentials[name],
    });
    expect(result.status).toBe('incomplete'); expect(result.runs).toBe(24);
    const manifest = JSON.parse(await readFile(path.join(root, f.storage, 'manifest.json'), 'utf8'));
    expect(manifest.runs.every((r: BatchRun) => r.audit?.complete)).toBe(true);
    const auditCalls = f.context.fetch.mock.calls.filter(([, init]) => {
      if (typeof init?.body !== 'string') return false;
      const body = JSON.parse(init!.body as string);
      return body.model === 'synthetic-audit';
    });
    expect(auditCalls).toHaveLength(24);
    expect(auditCalls.map(([, init]) => new Headers(init!.headers).get('authorization'))).toEqual(
      manifest.runs.map((r: BatchRun) => r.configuration === 'baseline' ? 'Bearer baseline-audit-secret' : 'Bearer extract-audit-secret'),
    );
  });
  it('missing authorization/prerequisites persist blockers before credential access', async () => {
    const f = await fixture(); f.config.routes[0].accountVerified = false;
    await f.put('config', f.config);
    expect((await runBenchmarkCli(f.args('run'), f.context)).status).toBe('blocked');
    expect(f.context.credential).not.toHaveBeenCalled(); expect(f.context.fetch).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, f.storage, 'blocked.json'), 'utf8')).toContain('account/version verification pending');
  });
  it('missing credential names and empty explicitly selected credentials block with no HTTP', async () => {
    const f = await fixture();
    expect((await runBenchmarkCli(f.args('run'), { ...f.context, envNames: [] })).exitCode).toBe(2);
    expect(f.context.credential).not.toHaveBeenCalled();
    expect((await runBenchmarkCli(f.args('run'), { ...f.context, credential: () => '' })).exitCode).toBe(2);
    expect(f.context.fetch).not.toHaveBeenCalled();
  });
  it('does not treat imported metadata as authentic gold and rejects in-batch approval/checkpoint channels', async () => {
    const f = await fixture(); await f.put('approvals', []);
    expect((await runBenchmarkCli(f.args('run'), f.context)).exitCode).toBe(2);
    expect(f.context.credential).not.toHaveBeenCalled(); expect(f.context.fetch).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, f.storage, 'gold-review-requests.json'), 'utf8')).toContain('gold-authenticity');
    f.files.checkpoint = path.join(f.storage, 'trust.json');
    expect((await runBenchmarkCli(f.args('run'), f.context)).exitCode).toBe(2);
  });
  it('rejects symlinked private input and unsafe output storage', async () => {
    const f = await fixture(); const link = path.join(f.inputs, 'link.json');
    await symlink(path.join(root, f.files.config), path.join(root, link));
    f.files.config = link;
    expect((await runBenchmarkCli(f.args('run'), f.context)).exitCode).toBe(2);
    f.config.storage.path = '../../public'; await f.put('config', f.config);
    expect((await runBenchmarkCli(f.args('run'), f.context)).exitCode).toBe(2);
    expect(f.context.fetch).not.toHaveBeenCalled();
  });
  it('prepare retains complete synthetic blocks and original narrative candidates pending human linking', async () => {
    const f = await fixture(); const sourceFile = path.join(f.inputs, 'synthetic.txt');
    await writeFile(path.join(root, sourceFile), Array.from({ length: 100 }, (_, i) => `Synthetic statement ${i}.`).join('\n'), { mode: 0o600 });
    const loss = { reason: 'Synthetic chart text absent.', location: { kind: 'slide', ref: 'Synthetic slide' } };
    const needsFile = await f.put('legacy-needs', { gaps: [{ statement: 'Older patients and renal impairment.', slide_cue: 'Synthetic slide' }, { statement: 'Synthetic explicit loss.', parsingLoss: loss }] });
    const tacticsFile = await f.put('legacy-tactics', { tactics: [{ title: 'Synthetic study.' }] });
    await f.put('sources', { parserVersion: 'local-pure-v1', frozenAt: '2026-10-13T12:00:00Z', entries: f.config.sources.map(s => ({ packId: s.packId, filename: 'synthetic.txt', sourceFile, legacyGold: { needsFile, tacticsFile } })) });
    const result = await runBenchmarkCli(['prepare', '--config', f.files.config, '--sources', f.files.sources], f.context);
    expect(result.exitCode).toBe(0); expect(result.status).toBe('prepared');
    const packs = JSON.parse(await readFile(path.join(root, f.storage, 'packs.json'), 'utf8'));
    expect(packs.every((p: { source: { blocks: unknown[] }; gold: { needs: { review: { status: string } } } }) => p.source.blocks.length === 100 && p.gold.needs.review.status === 'pending')).toBe(true);
    const candidates = JSON.parse(await readFile(path.join(root, f.storage, 'gold-candidates.json'), 'utf8'));
    expect(candidates[0].needs).toHaveLength(2); expect(candidates[0].needs[0].parsingLoss).toBeNull();
    expect(candidates[0].needs[1].parsingLoss).toEqual(loss);
    expect(candidates[0].needs[0].original.statement).toBe('Older patients and renal impairment.');
    expect((await runBenchmarkCli(['prepare', '--config', f.files.config, '--sources', f.files.sources], f.context)).exitCode).toBe(2);
    expect(f.context.fetch).not.toHaveBeenCalled(); expect(f.context.credential).not.toHaveBeenCalled();
  });
  it('imports human gold locally, stages exact contents first, preserves prior gold and requires separate approval', async () => {
    const f = await fixture(); const sourceFile = path.join(f.inputs, 'synthetic.txt');
    await writeFile(path.join(root, sourceFile), f.bytes, { mode: 0o600 });
    await f.put('sources', { parserVersion: 'synthetic-v1', frozenAt: '2026-10-13T12:00:00Z', entries: f.config.sources.map(s => ({ packId: s.packId, filename: 'synthetic.txt', sourceFile })) });
    f.config.referenceVersion = 'v2'; await f.put('config', f.config);
    const gold = Object.fromEntries(f.packs.map(p => [p.packId, { needs: p.gold.needs.items, tactics: p.gold.tactics.items,
      needsReview: { ...p.gold.needs.review, referenceVersion: 'v2' }, tacticsReview: { ...p.gold.tactics.review, referenceVersion: 'v2' } }]));
    await f.put('gold', { frozenAt: '2026-10-13T12:00:00Z', gold }); await f.put('approvals', []);
    const args = ['review', ...['config', 'packs', 'sources', 'gold', 'approvals'].flatMap(k => [`--${k}`, f.files[k]])];
    expect((await runBenchmarkCli(args, f.context)).exitCode).toBe(2);
    const requests = JSON.parse(await readFile(path.join(root, f.storage, 'gold-review-requests.json'), 'utf8'));
    await f.put('approvals', requests.map((r: { digest: string }) => r.digest));
    expect((await runBenchmarkCli(args, f.context)).status).toBe('prepared');
    const approved = JSON.parse(await readFile(path.join(root, f.storage, 'approved-packs.json'), 'utf8'));
    expect(approved.every((p: { referenceVersion: string; sourceHash: string }, i: number) => p.referenceVersion === 'v2' && p.sourceHash === f.packs[i].sourceHash)).toBe(true);
    expect(await readFile(path.join(root, f.storage, `prior-gold-${artifactDigest(f.packs)}.json`), 'utf8')).toContain('"referenceVersion": "v1"');
    expect(f.context.fetch).not.toHaveBeenCalled(); expect(f.context.credential).not.toHaveBeenCalled();
  });
  it('refuses review of absent or incomplete execution without loading credentials or calling HTTP', async () => {
    const f = await fixture(); await f.put('decisions', {});
    const args = [...f.args('review'), '--decisions', f.files.decisions];
    expect((await runBenchmarkCli(args, f.context)).exitCode).toBe(2);
    await f.put('checkpoint', '0'.repeat(64));
    expect((await runBenchmarkCli(args, f.context)).exitCode).toBe(2);
    expect(f.context.credential).not.toHaveBeenCalled(); expect(f.context.fetch).not.toHaveBeenCalled();
  });
});
