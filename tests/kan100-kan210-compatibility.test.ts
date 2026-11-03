/** Fixed evidence captured from Accuracy at 5753c86 before the ownership move. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import identity from './fixtures/kan210-original/identity.json';
import { artifactDigest } from '@/modules/development/evaluation/benchmark/artifacts';
import { FROZEN_AUDIT_PROCESS_HASH } from '@/modules/development/evaluation/benchmark/audit';
import { scoringIdentity } from '@/modules/development/evaluation/benchmark/scoring';
import { runBenchmarkBatch, type BatchRun, type BatchServices } from '@/modules/development/evaluation/benchmark/batch';
import { runBenchmarkCli } from '@/modules/development/evaluation/benchmark/scripts/kan100-benchmark';
import { NEED_PROPOSER_SYSTEM } from '@/modules/development/evaluation/historical/need-extract/prompts';
import { INVENTORY_PROPOSER_SYSTEM } from '@/modules/development/evaluation/historical/inventory-extract/prompts';
import { COMPLETENESS_CRITIC_SYSTEM, completenessCriticUser } from '@/modules/development/evaluation/historical/completeness-audit/prompts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'tests/fixtures/kan210-original');
const inputs = 'data/runtime/benchmark/inputs-kan210-original-synthetic';
const storage = 'data/runtime/benchmark/kan210-original-synthetic';
const json = async (name: string) => JSON.parse(await readFile(path.join(fixture, name), 'utf8'));
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([inputs, storage].map(p => rm(path.join(root, p), { recursive: true, force: true })));
});

describe('historical evaluation relocation compatibility', () => {
  it('retains both original runner identities and exact prompt content', () => {
    // Arrange / Act: load the moved implementation through each original runner.
    const tsxHash = execFileSync(process.execPath, ['--import', 'tsx', '-e', "console.log(require('./src/modules/development/evaluation/benchmark/audit.ts').FROZEN_AUDIT_PROCESS_HASH)"], { cwd: root, encoding: 'utf8' }).trim();
    // Assert: these are pre-move values, never refreshed by the move.
    expect(FROZEN_AUDIT_PROCESS_HASH).toBe(identity.auditProcessHash);
    expect(tsxHash).toBe(identity.tsxAuditProcessHash);
    expect({ need: artifactDigest(NEED_PROPOSER_SYSTEM), inventory: artifactDigest(INVENTORY_PROPOSER_SYSTEM), audit: artifactDigest(COMPLETENESS_CRITIC_SYSTEM), auditUser: artifactDigest(completenessCriticUser.toString()) }).toEqual(identity.promptHashes);
  });

  it('checks immutable saved fixture bytes, pack/config and every scoring identity', async () => {
    const [config, packs, manifest] = await Promise.all([json('inputs/config.json'), json('inputs/packs.json'), json('artifacts/manifest.json')]);
    expect(artifactDigest(config)).toBe(identity.configDigest);
    expect(artifactDigest(packs)).toBe(identity.packDigest);
    expect(manifest.runs.map((run: BatchRun) => scoringIdentity(packs.find((p: { packId: string }) => p.packId === run.packId), run.stage, run.extraction!.findings))).toEqual(identity.scoringIdentities);
    for (const [name, digest] of Object.entries(identity.artifacts)) expect(createHash('sha256').update(await readFile(path.join(fixture, 'artifacts', name))).digest('hex'), name).toBe(digest);
    expect(manifest.status).toBe('completed');
    expect(manifest.runs).toHaveLength(24);
  });

  it('resumes and reviews the original saved matrix with no transport or credential access and byte-equivalent evidence', async () => {
    // Arrange: copy retained original evidence into isolated, git-ignored private storage.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(identity.capturedAt));
    for (const [source, target] of [['inputs', inputs], ['artifacts', storage]]) {
      await mkdir(path.join(root, target), { recursive: true, mode: 0o700 });
      for (const name of await readdir(path.join(fixture, source))) {
        const destination = path.join(root, target, name);
        await copyFile(path.join(fixture, source, name), destination);
        // Git checkouts use 0644; saved runtime evidence must be private regardless of source mode.
        await chmod(destination, 0o600);
      }
    }
    const [config, packs, runtime, decisions, approvals, checkpoint] = await Promise.all(['config', 'packs', 'runtime', 'decisions', 'approvals', 'checkpoint'].map(name => json(`inputs/${name}.json`)));
    const noPaid = vi.fn(() => { throw new Error('Provider/credential access forbidden during saved-run compatibility verification'); });
    const services: BatchServices = { root, envNames: config.routes.map((route: { credentialEnvName: string }) => route.credentialEnvName), baselines: runtime.baselines, projectId: runtime.projectId, auditSettings: runtime.auditSettings, pricing: runtime.pricing, maxPolls: runtime.maxPolls, reportEvidenceKind: 'synthetic', resumeDigest: checkpoint, extraction: noPaid, audit: { complete: noPaid }, human: async ({ run }) => decisions[run.id], verifyReview: async request => approvals.includes(request.digest), onCheckpoint: async digest => { await writeFile(path.join(root, inputs, 'checkpoint.json'), JSON.stringify(digest)); } };
    // Act: both direct saved-run resume and CLI review must use retained outputs.
    const resumed = await runBenchmarkBatch(config, packs, services);
    expect(resumed.status).toBe('completed');
    const args = ['review', ...['config', 'packs', 'runtime', 'checkpoint', 'approvals', 'decisions'].flatMap(name => [`--${name}`, `${inputs}/${name}.json`])];
    const reviewed = await runBenchmarkCli(args, { root, envNames: [], fetch: noPaid, credential: noPaid });
    // Assert: historical saved evidence is unchanged, including human decisions/reports/CSV.
    expect(reviewed.status).toBe('completed');
    expect(reviewed.checkpointDigest).toBe(identity.completed.checkpointDigest);
    expect(noPaid).not.toHaveBeenCalled();
    const originalDirectory = identity.completed.artifactDirectory;
    for (const name of Object.keys(identity.artifacts)) {
      const actual = (await readFile(path.join(root, storage, name), 'utf8')).replaceAll(path.join(root, storage), originalDirectory);
      expect(actual, name).toBe(await readFile(path.join(fixture, 'artifacts', name), 'utf8'));
    }
  });
});
