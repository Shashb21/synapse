/** Explicit local CLI. No production routing, environment loader or DB imports. */
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { benchmarkConfigSchema, type BenchmarkConfig } from '../contracts';
import { checkPreflight } from '../preflight';
import { freezeReferencePack, type FrozenReferencePack, type FreezeReferencePackInput } from '../inputs';
import { artifactDigest, PrivateBatchStorage } from '../artifacts';
import { runBenchmarkBatch, type BatchServices, type BatchHumanReview, type ReviewVerificationRequest } from '../batch';
import { parseLocalDocument } from '@/lib/ingest/local-parse';
import JSZip from 'jszip';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = z.strictObject({ call_kind: z.enum(['need_extract', 'inventory_extract']), role: z.literal('proposer'),
  provider_id: text, model: text, params: z.strictObject({ temperature: z.number().finite(), max_tokens: z.number().int().positive() }),
  fallbacks: z.array(text).length(0), degraded: z.literal(false), reason: z.string().nullable() });
const baseline = z.strictObject({ snapshot, shallowCycle: z.boolean(), baseUrl: z.url() });
const amount = z.number().finite().nonnegative();
const runtimeSchema = z.strictObject({
  baselines: z.strictObject({ need_extract: baseline, inventory_extract: baseline }),
  auditBaseUrl: z.url(), auditSettings: z.strictObject({ temperature: z.number().finite(), max_tokens: z.number().int().positive() }),
  projectId: text, maxPolls: z.number().int().min(1).max(100),
  pricing: z.strictObject({ asOf: z.iso.date(), source: text, baselineMaxUsd: amount, extractJobMaxUsd: amount,
    uploadMaxUsd: amount, auditMaxUsd: amount, inputUsdPerMillion: amount, outputUsdPerMillion: amount }),
  overheadCharges: z.strictObject({ setupUsd: amount.nullable(), tuningUsd: amount.nullable() }).optional(),
  referenceCorrection: z.strictObject({ rationale: text, reviewerId: text, reviewedAt: z.iso.datetime() }).optional(),
});
type Runtime = z.infer<typeof runtimeSchema>;
const sourcesSchema = z.strictObject({ parserVersion: text, frozenAt: z.iso.datetime(), entries: z.array(z.strictObject({
  packId: text, filename: text, sourceFile: text, goldFile: text.optional(),
  legacyGold: z.strictObject({ needsFile: text, tacticsFile: text }).optional(),
})).min(1) });
const stages = ['need_extract', 'inventory_extract'] as const;
const origins: Record<string, string> = { 'xai-grok': 'https://api.x.ai', openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai', 'anthropic-claude': 'https://api.anthropic.com', 'google-gemini': 'https://generativelanguage.googleapis.com' };
class Blocked extends Error { constructor(readonly reasons: string[]) { super('blocked'); } }
export type CliResult = { exitCode: number; status: 'prepared' | 'completed' | 'incomplete' | 'blocked' | 'error';
  reasons?: string[]; artifactDirectory?: string; checkpointDigest?: string; runs?: number; sources?: unknown };
export type CliContext = { root?: string; envNames?: readonly string[]; credential?: (name: string) => string | undefined; fetch?: typeof fetch };

/** Read only an explicitly named excluded, private regular JSON input. */
async function privateFile(root: string, selected: string, missing = false): Promise<string> {
  const target = path.resolve(root, selected), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Blocked(['Private input must be inside the isolated workspace.']);
  await promisify(execFile)('git', ['check-ignore', '--quiet', '--', relative], { cwd: root, timeout: 10_000 });
  let cursor = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cursor) !== cursor) throw new Blocked(['Private input symlink rejected.']);
  }
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077) throw new Blocked(['Private input needs a regular file with mode 600.']);
  } catch (e) { if (!missing || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return target;
}
async function readJson(root: string, selected: string): Promise<unknown> {
  const handle = await open(await privateFile(root, selected), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
}
/** Trusted checkpoint is separate from editable batch artifacts and never inferred. */
async function trustedCheckpoint(root: string, selected: string, storage: string) {
  const target = await privateFile(root, selected, true);
  const batch = path.resolve(root, storage);
  if (target === batch || target.startsWith(batch + path.sep)) throw new Blocked(['Checkpoint/approvals must be outside batch artifacts.']);
  if ((await lstat(path.dirname(target))).mode & 0o077) throw new Blocked(['Trusted channel directory needs mode 700.']);
  let latest: string | undefined;
  try { latest = digest.parse(await readJson(root, selected)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return { latest, write: async (value: string) => {
    await privateFile(root, selected, true);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await privateFile(root, path.relative(root, tmp), true);
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try {
      await privateFile(root, selected, true); await rename(tmp, target);
      const directory = await open(path.dirname(target), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await unlink(tmp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }); }
  } };
}
function goldRequest(pack: FrozenReferencePack): ReviewVerificationRequest {
  const contents = { kind: 'gold', pack };
  return { kind: 'human-review', identity: { packId: pack.packId, purpose: 'gold-authenticity' }, contents, digest: artifactDigest(contents) };
}
async function approvals(root: string, selected: string, storage: string) {
  const target = await privateFile(root, selected);
  if (target.startsWith(path.resolve(root, storage) + path.sep) || (await lstat(path.dirname(target))).mode & 0o077) throw new Blocked(['Human approvals need a private operator channel outside editable batch artifacts.']);
  return new Set(z.array(digest).parse(await readJson(root, selected)));
}
async function save(root: string, storage: string, files: Record<string, unknown>) {
  const owner = await PrivateBatchStorage.acquire(root, storage);
  try { for (const [name, contents] of Object.entries(files)) await owner.write(name, JSON.stringify(contents, null, 2)); }
  finally { await owner.close(); }
}
async function prepare(root: string, config: BenchmarkConfig, selected: string): Promise<CliResult> {
  const input = sourcesSchema.parse(await readJson(root, selected));
  if (input.entries.length !== config.sources.length || new Set(input.entries.map(e => e.packId)).size !== input.entries.length || input.entries.some(e => !config.sources.some(s => s.packId === e.packId))) throw new Blocked(['Source manifest must cover every separate configured pack.']);
  // Verify exclusion/permissions BEFORE reading actual source bytes.
  const owner = await PrivateBatchStorage.acquire(root, config.storage.path);
  try {
    if (await owner.read('packs.json') || await owner.read('manifest.json')) throw new Blocked(['Preparation already exists; use a new batch directory to preserve prior evidence.']);
    const packs: FrozenReferencePack[] = [], summaries = [], candidates = [];
    const preparedConfig = structuredClone(config);
    preparedConfig.goldReviewed = false;
    for (const entry of input.entries) {
      const sourcePath = path.resolve(root, entry.sourceFile);
      if (!sourcePath.startsWith(root + path.sep) || await realpath(sourcePath) !== sourcePath) throw new Blocked(['Source traversal/symlink rejected.']);
      const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = await sourceHandle.readFile(); } finally { await sourceHandle.close(); }
      const blocks = (await parseLocalDocument({ filename: entry.filename, buffer: bytes })).blocks;
      const source = preparedConfig.sources.find(s => s.packId === entry.packId)!;
      source.hash = createHash('sha256').update(bytes).digest('hex'); source.blocks = blocks.length;
      source.complete = true; source.inputTokens = null;
      let gold: FreezeReferencePackInput['gold'] = { needs: [], tactics: [] };
      if (entry.goldFile) {
        gold = await readJson(root, entry.goldFile) as FreezeReferencePackInput['gold'];
        candidates.push({ packId: entry.packId, originalGold: gold, status: 'pending-human-review' });
        gold = { ...gold, needsReview: { status: 'pending' }, tacticsReview: { status: 'pending' } };
      }
      if (entry.legacyGold) {
        if (entry.goldFile) throw new Blocked(['Choose explicit benchmark gold or legacy candidate inputs.']);
        const originals = { needs: await readJson(root, entry.legacyGold.needsFile), tactics: await readJson(root, entry.legacyGold.tacticsFile) };
        const rows = (value: unknown, key: string) => z.array(z.record(z.string(), z.json())).parse(z.record(z.string(), z.unknown()).parse(value)[key]);
        candidates.push({ packId: entry.packId, originals, status: 'pending-human-review',
          needs: rows(originals.needs, 'gaps').map((row, i) => ({ id: `legacy-need-${i + 1}`, statement: row.statement,
            original: row, blockIds: row.blockIds ?? [], parsingLoss: row.parsingLoss ?? null, approval: 'pending', atomicDecomposition: 'human-required' })),
          tactics: rows(originals.tactics, 'tactics').map((row, i) => ({ id: `legacy-tactic-${i + 1}`, statement: row.title,
            original: row, blockIds: row.blockIds ?? [], parsingLoss: row.parsingLoss ?? null, approval: 'pending', atomicDecomposition: 'human-required' })),
          limitations: 'Unlinked rows are unresolved, not inferred parsing losses. Preserve confirmed losses when creating human gold.' });
      }
      const pack = await freezeReferencePack({ packId: entry.packId, filename: entry.filename, originalFile: bytes,
        config: preparedConfig, parserVersion: input.parserVersion, frozenAt: input.frozenAt, blocks, gold });
      packs.push(pack);
      const slides = new Set(blocks.filter(b => b.location.kind === 'slide').map(b => b.location.ref)).size;
      const xmlSlides = entry.filename.toLowerCase().endsWith('.pptx') ? Object.keys((await JSZip.loadAsync(bytes)).files).filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f)).length : null;
      summaries.push({ packId: pack.packId, blocks: blocks.length, parsedSlides: slides, xmlSlides,
        originalFileHash: pack.originalFileHash, sourceHash: pack.sourceHash, packHash: pack.packHash });
    }
    preparedConfig.budget.sizeBasisHash = preparedConfig.sources.map(s => s.hash).join(',');
    const reasons = ['Human-reviewed authentic gold and atomic/link/loss decisions are pending.',
      'Input-token sizing and live authorization/account/citation/baseline/pricing evidence must be supplied.'];
    await owner.write('prepare.json', JSON.stringify({ status: 'prepared', summaries, reasons,
      limitations: 'All local parsed text runs retained without cap. No OCR, image/chart/notes extraction or guaranteed relationship slide ordering; blank/image-only slides may lack blocks. Parsed completeness is not semantic completeness.' }, null, 2));
    await owner.write('prepared-config.json', JSON.stringify(preparedConfig, null, 2));
    await owner.write('original-config.json', JSON.stringify(config, null, 2));
    await owner.write('packs.json', JSON.stringify(packs, null, 2));
    await owner.write('gold-candidates.json', JSON.stringify(candidates, null, 2));
    await owner.write('gold-review-requests.json', JSON.stringify(packs.map(goldRequest), null, 2));
    await owner.write('blocked.json', JSON.stringify({ status: 'blocked', reasons }, null, 2));
    return { exitCode: 0, status: 'prepared', artifactDirectory: owner.directory, sources: summaries, reasons };
  } finally { await owner.close(); }
}
function endpoint(provider: string, baseUrl: string) {
  const url = new URL(baseUrl);
  const expectedPath: Record<string, string> = { 'xai-grok': '/v1', openai: '/v1', openrouter: '/api/v1', 'anthropic-claude': '', 'google-gemini': '/v1beta' };
  if (!origins[provider] || url.origin !== origins[provider] || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== expectedPath[provider]) throw new Blocked(['Unsupported explicit provider endpoint.']);
  return baseUrl.replace(/\/$/, '');
}
/** Import human gold with original-byte verification and already frozen blocks.
 * This local-only path is available before a batch exists; later corrections must
 * use batch's authenticated prior/next-content correction contract instead.
 */
async function importGold(root: string, config: BenchmarkConfig, flags: Record<string, string>): Promise<CliResult> {
  if (!flags.packs || !flags.sources || !flags.approvals) throw new Blocked(['Gold import requires explicit packs, sources and separate approvals.']);
  const prior = z.array(z.unknown()).min(1).parse(await readJson(root, flags.packs)) as FrozenReferencePack[];
  const input = z.strictObject({ frozenAt: z.iso.datetime(), gold: z.record(z.string(), z.unknown()) }).parse(await readJson(root, flags.gold));
  const sources = sourcesSchema.parse(await readJson(root, flags.sources));
  const approved = await approvals(root, flags.approvals, config.storage.path);
  const owner = await PrivateBatchStorage.acquire(root, config.storage.path);
  try {
    if (await owner.read('manifest.json')) throw new Blocked(['Existing runs require batch referenceCorrection and whole-matrix review; local gold import cannot replace their reference.']);
    if (prior.length !== config.sources.length || Object.keys(input.gold).length !== prior.length || new Set(prior.map(p => p.packId)).size !== prior.length) throw new Blocked(['Human gold must cover every frozen pack separately.']);
    const packs = [];
    for (const pack of prior) {
      const { packHash, ...payload } = pack;
      if (packHash !== artifactDigest(payload) || pack.sourceHash !== artifactDigest(pack.source)) throw new Blocked(['Frozen source contents changed before gold import.']);
      const entry = sources.entries.find(e => e.packId === pack.packId);
      if (!entry || !input.gold[pack.packId]) throw new Blocked(['Explicit original source and human gold are missing.']);
      const sourcePath = path.resolve(root, entry.sourceFile);
      if (!sourcePath.startsWith(root + path.sep) || await realpath(sourcePath) !== sourcePath) throw new Blocked(['Original source traversal/symlink rejected.']);
      const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = await handle.readFile(); } finally { await handle.close(); }
      const next = await freezeReferencePack({ packId: pack.packId, filename: pack.filename, originalFile: bytes, config,
        parserVersion: pack.parserVersion, frozenAt: input.frozenAt, blocks: pack.source.blocks,
        gold: input.gold[pack.packId] as FreezeReferencePackInput['gold'] });
      if (next.originalFileHash !== pack.originalFileHash || next.sourceHash !== pack.sourceHash || Object.values(next.gold).some(s => s.review.status !== 'approved')) throw new Blocked(['Gold import requires unchanged source and explicit human-approved stage metadata.']);
      packs.push(next);
    }
    const requests = packs.map(goldRequest);
    await owner.write(`prior-gold-${artifactDigest(prior)}.json`, JSON.stringify(prior, null, 2));
    await owner.write('staged-gold-packs.json', JSON.stringify(packs, null, 2));
    await owner.write('gold-review-requests.json', JSON.stringify(requests, null, 2));
    if (requests.some(r => !approved.has(r.digest))) throw new Blocked(['Human gold staged; inspect exact contents and approve their digests in the separate operator file.']);
    await owner.write('approved-packs.json', JSON.stringify(packs, null, 2));
    await owner.write('approved-config.json', JSON.stringify({ ...config, goldReviewed: true }, null, 2));
    return { exitCode: 0, status: 'prepared', artifactDirectory: owner.directory,
      reasons: ['Gold imported with separately approved exact contents. Live readiness and final run judgments remain independent.'] };
  } finally { await owner.close(); }
}
function record(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function count(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }
function normalizedUsage(raw: Record<string, unknown>) {
  const u = record(raw.usage), g = record(raw.usageMetadata);
  if (Object.keys(g).length) { const out = count(g.candidatesTokenCount); return { input_tokens: count(g.promptTokenCount), output_tokens: out === null ? null : out + (count(g.thoughtsTokenCount) ?? 0) }; }
  const input = count(u.input_tokens ?? u.prompt_tokens);
  return { input_tokens: input === null ? null : input + (count(u.cache_creation_input_tokens) ?? 0) + (count(u.cache_read_input_tokens) ?? 0), output_tokens: count(u.output_tokens ?? u.completion_tokens) };
}
function auditTransport(runtime: Runtime, key: string, fetch: typeof globalThis.fetch): BatchServices['audit'] {
  return { redactValues: [key], complete: async request => {
    const provider = request.route.providerId, base = endpoint(provider, runtime.auditBaseUrl);
    let url = `${base}/chat/completions`, headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    let body: unknown = { model: request.route.requestedModel, ...request.settings, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] };
    if (provider === 'openrouter') {
      headers = { ...headers, 'http-referer': 'https://github.com/Shashb21/synapse', 'x-title': 'Synapse IEGP' };
      body = { ...record(body), response_format: { type: 'json_object' } };
    }
    if (provider === 'anthropic-claude') {
      url = `${base}/v1/messages`; headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = { model: request.route.requestedModel, ...request.settings, system: request.system, messages: [{ role: 'user', content: request.user }] };
    } else if (provider === 'google-gemini') {
      url = `${base}/models/${encodeURIComponent(request.route.requestedModel)}:generateContent`;
      headers = { 'content-type': 'application/json', 'x-goog-api-key': key };
      body = { systemInstruction: { parts: [{ text: request.system }] }, contents: [{ role: 'user', parts: [{ text: request.user }] }], generationConfig: { temperature: request.settings.temperature, maxOutputTokens: request.settings.max_tokens, responseMimeType: 'application/json' } };
    }
    // Exactly one native fetch. Batch owns timeout, pricing, retries and saved redaction.
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal });
    const rawText = await response.text();
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(rawText)); } catch { payload = { unparsedBody: rawText }; }
    const usage = normalizedUsage(payload);
    if (!response.ok) throw { temporary: [408, 429, 500, 502, 503, 504].includes(response.status), httpStatus: response.status, raw: payload, usage };
    const model = payload.model ?? payload.modelVersion;
    const choice = record((payload.choices as unknown[] | undefined)?.[0]);
    const candidate = record((payload.candidates as unknown[] | undefined)?.[0]);
    const value = provider === 'anthropic-claude' ? (payload.content as unknown[] | undefined)?.map(p => record(p).text).join('\n') : provider === 'google-gemini' ? (record(candidate.content).parts as unknown[] | undefined)?.map(p => record(p).text).join('\n') : record(choice.message).content;
    if (typeof model !== 'string' || typeof value !== 'string' || choice.finish_reason === 'length' || payload.stop_reason === 'max_tokens' || candidate.finishReason === 'MAX_TOKENS' || payload.error) throw { temporary: false, httpStatus: response.status, raw: payload, usage };
    let verdicts: unknown;
    try { verdicts = JSON.parse(value); } catch { throw { temporary: false, httpStatus: response.status, raw: payload, usage }; }
    return { raw: { ...record(verdicts), providerResponse: payload }, providerId: provider, model, settingsHash: artifactDigest(request.settings), usage };
  } };
}
async function execute(root: string, command: string, config: BenchmarkConfig, flags: Record<string, string>, context: CliContext): Promise<CliResult> {
  for (const name of ['packs', 'runtime', 'checkpoint', 'approvals']) if (!flags[name]) throw new Blocked(['Explicit packs, runtime, checkpoint and approvals files are required.']);
  const packs = z.array(z.unknown()).min(1).parse(await readJson(root, flags.packs)) as FrozenReferencePack[];
  const runtime = runtimeSchema.parse(await readJson(root, flags.runtime));
  const checkpoint = await trustedCheckpoint(root, flags.checkpoint, config.storage.path);
  const approved = await approvals(root, flags.approvals, config.storage.path);
  const requests: ReviewVerificationRequest[] = packs.map(goldRequest);
  if (packs.some(p => Object.values(p.gold).some(g => g.review.status !== 'approved') || !approved.has(goldRequest(p).digest))) {
    await save(root, config.storage.path, { 'gold-review-requests.json': requests });
    throw new Blocked(['Exact gold contents require separately evidenced human approval; review metadata is insufficient.']);
  }
  const decisions = flags.decisions ? z.record(z.string(), z.unknown()).parse(await readJson(root, flags.decisions)) as Record<string, BatchHumanReview> : {};
  const envNames = context.envNames ?? Object.keys(process.env);
  const preflight = checkPreflight(config, command === 'review' ? [...envNames, ...config.routes.map(r => r.credentialEnvName)] : envNames);
  if (!preflight.ready) throw new Blocked(preflight.blockers);
  const auditRoute = config.routes.find(r => r.stage === 'completeness_audit')!;
  endpoint(auditRoute.providerId, runtime.auditBaseUrl);
  for (const stage of stages) endpoint(runtime.baselines[stage].snapshot.provider_id, runtime.baselines[stage].baseUrl);
  if (config.baselineSnapshot !== artifactDigest(runtime.baselines)) throw new Blocked(['Resolved baseline export does not match the frozen snapshot.']);
  const secrets = new Map<string, string>();
  if (command === 'review') {
    if (!checkpoint.latest || !flags.decisions) throw new Blocked(['Review requires explicit decisions and a trusted latest checkpoint.']);
    const owner = await PrivateBatchStorage.acquire(root, config.storage.path);
    try {
      const manifest = JSON.parse((await owner.read('manifest.json')) ?? 'null');
      if (!manifest || artifactDigest(manifest) !== checkpoint.latest || manifest.runs.length !== config.sources.length * 12 || manifest.runs.some((r: { extraction?: { status: string }; audit?: { complete: boolean } }) => r.extraction?.status !== 'completed' || !r.audit?.complete) || manifest.jobs.some((j: { complete: boolean }) => !j.complete)) throw new Blocked(['Review only rescoring requires completed saved extraction/audits/billing with a verified checkpoint. Use run to resume incomplete execution.']);
    } finally { await owner.close(); }
  } else {
    // Values are accessed ONLY after no-DB-env, explicit configuration and readiness.
    for (const name of new Set(config.routes.map(r => r.credentialEnvName))) {
      const value = (context.credential ?? (n => process.env[n]))(name);
      if (!value?.trim()) throw new Blocked(['Selected provider credential is missing or empty.']);
      secrets.set(name, value);
    }
  }
  const noPaid = () => { throw new Blocked(['Review cannot invoke provider work.']); };
  const services: BatchServices = { root, envNames: command === 'review' ? config.routes.map(r => r.credentialEnvName) : envNames,
    baselines: runtime.baselines, projectId: runtime.projectId, auditSettings: runtime.auditSettings, pricing: runtime.pricing,
    maxPolls: runtime.maxPolls, overheadCharges: runtime.overheadCharges, referenceCorrection: runtime.referenceCorrection,
    resumeDigest: checkpoint.latest, onCheckpoint: checkpoint.write,
    extraction: command === 'review' ? noPaid : route => ({ fetch: context.fetch ?? globalThis.fetch, apiKey: secrets.get(route.credentialEnvName)! }),
    audit: command === 'review' ? { complete: noPaid } : { ...auditTransport(runtime, secrets.get(auditRoute.credentialEnvName)!, context.fetch ?? globalThis.fetch), redactValues: [...secrets.values()] },
    human: async ({ run }) => decisions[run.id] ?? null,
    verifyReview: async request => { requests.push(request); return request.digest === artifactDigest(request.contents) && approved.has(request.digest); },
  };
  let result;
  try { result = await runBenchmarkBatch(config, packs, services); }
  catch (e) {
    // Only fixed messages from the batch contract may cross the CLI boundary;
    // filesystem/provider exceptions and input values remain private.
    const safe = new Set(['Frozen pack identity/content mismatch', 'Frozen gold review is pending; caller boolean is insufficient',
      'Complete separate pack matrix required', 'Explicit dated conservative prices required', 'Audit process hash mismatch',
      'Frozen route settings/content mismatch', 'Trusted latest resume digest required; checkpoint contents changed',
      'Frozen execution/configuration changed', 'Explicit reviewed full-matrix reference correction required',
      'Reference correction authentication pending', 'Resume checkpoint missing', 'Derived full experiment reservations exceed ceiling',
      'Preflight plan does not cover all actual operations/revisions/polls/retries', 'Known overhead charges cannot be discarded',
      'Nonfinite or invalid derived ledger totals']);
    if (e instanceof Error && safe.has(e.message)) throw new Blocked([e.message]);
    throw e;
  }
  finally {
    // Stage correction requests even when approval is still pending. Redact values
    // structurally so quotes/backslashes in a credential cannot break JSON.
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') return [...secrets.values()].reduce((v, secret) => v.split(secret).join('[REDACTED]'), value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redact(v)]));
      return value;
    };
    await save(root, config.storage.path, { 'review-requests.json': redact(requests), [`runtime-${artifactDigest(runtime)}.json`]: redact(runtime) });
  }
  return { exitCode: result.status === 'completed' ? 0 : 2, status: result.status, reasons: result.reasons,
    artifactDirectory: result.artifactDirectory, checkpointDigest: result.checkpointDigest, runs: result.runs.length };
}

/** Run prepare/run/review with explicit private inputs. Returns sanitized status;
 * caller chooses process exit. Tests may supply an isolated name/value/HTTP seam.
 * Unknown flags, malformed JSON and I/O errors never echo values or stack traces.
 */
export async function runBenchmarkCli(argv: readonly string[], context: CliContext = {}): Promise<CliResult> {
  let config: BenchmarkConfig | undefined, root = context.root ?? process.cwd();
  try {
    root = await realpath(root);
    const [command, ...args] = argv;
    if (!['prepare', 'run', 'review'].includes(command)) return { exitCode: 1, status: 'error', reasons: ['Use prepare, run or review with explicit private JSON files.'] };
    const names = context.envNames ?? Object.keys(process.env);
    if (names.some(n => /DATABASE|POSTGRES|^PG|SUPABASE|DB_URL|DB_HOST|DB_PASSWORD/i.test(n))) throw new Blocked(['Remove database environment names from the isolated process.']);
    const flags: Record<string, string> = {};
    const allowed = command === 'prepare' ? ['config', 'sources'] : command === 'review' ? ['config', 'packs', 'runtime', 'checkpoint', 'approvals', 'decisions', 'gold', 'sources'] : ['config', 'packs', 'runtime', 'checkpoint', 'approvals', 'decisions'];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.includes(key) || flags[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Blocked(['Unknown, duplicate or missing explicit CLI argument.']);
      flags[key] = args[i + 1];
    }
    if (!flags.config) throw new Blocked(['Explicit private config JSON is required.']);
    config = benchmarkConfigSchema.parse(await readJson(root, flags.config));
    if (command === 'prepare') {
      if (!flags.sources) throw new Blocked(['Explicit private sources JSON is required.']);
      return await prepare(root, config, flags.sources);
    }
    if (command === 'review' && flags.gold) {
      if (flags.runtime || flags.checkpoint || flags.decisions) throw new Blocked(['Gold import and saved-run review are separate explicit operations.']);
      return await importGold(root, config, flags);
    }
    return await execute(root, command, config, flags, context);
  } catch (e) {
    const reasons = e instanceof Blocked ? e.reasons : ['Invalid private inputs or isolated storage; inspect file format, permissions and exclusion locally.'];
    if (config) {
      try { await save(root, config.storage.path, { 'blocked.json': { status: 'blocked', reasons } }); }
      catch { /* Never weaken exclusion or disclose input/error values to save evidence. */ }
    }
    return { exitCode: e instanceof Blocked ? 2 : 1, status: e instanceof Blocked ? 'blocked' : 'error', reasons };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBenchmarkCli(process.argv.slice(2)).then(result => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode; }, () => { process.stderr.write('Isolated CLI failed.\n'); process.exitCode = 1; });
}
