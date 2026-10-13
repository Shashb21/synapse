/** Restart-safe, isolated benchmark orchestration. Explicit inputs and single-call
 * transports only; no application DB, provider/env module or deployment writes.
 */
import { benchmarkConfigSchema, type BenchmarkConfig, type BenchmarkRoute } from './contracts';
import { checkPreflight } from './preflight';
import type { FrozenReferencePack } from './inputs';
import { extractStage, type ExtractRequest, type ExtractResult, type ExtractState, type ExtractTransport } from './extract';
import { scoreStage, scoringIdentity, type HumanJudgments, type StageScore, type ScoringStage } from './scoring';
import { FROZEN_AUDIT_PROCESS_HASH, prepareAudit, validateAudit, auditOutput, scoreAudit, type AuditChunk, type AuditOutput, type AuditHumanRecords, type AuditScore } from './audit';
import type { CompletenessVerdict } from '../../modules/completeness-audit/engine';
import { artifactDigest, analysisCsv, PrivateBatchStorage } from './artifacts';

export type BatchPricing = {
  asOf: string; source: string;
  baselineMaxUsd: number; extractJobMaxUsd: number; uploadMaxUsd: number; auditMaxUsd: number;
  /** Conservative rates applicable to ALL supplied baseline/audit routes, including cache/reasoning. */
  inputUsdPerMillion: number; outputUsdPerMillion: number;
};
export type AuditReply = { raw: unknown; providerId: string; model: string; settingsHash: string; usage: unknown };
export type AuditAttempt = { id: string; chunkId: string; startedAt: string; elapsedMs: number; status: 'started' | 'completed' | 'failed'; raw?: unknown; usage?: unknown; actual?: { providerId: string; model: string; settingsHash: string }; verdicts?: CompletenessVerdict[]; temporary?: boolean; httpStatus?: number | null; error?: string };
export type BatchRun = {
  id: string; packId: string; stage: ScoringStage; configuration: 'baseline' | 'extract'; repetition: number;
  route: BenchmarkRoute; auditRoute: BenchmarkRoute;
  extractionState?: ExtractState; extraction?: ExtractResult;
  extractionHistory: ExtractResult[]; extractionElapsedMs: number; retryUsed: boolean; polls: number;
  auditAttempts: AuditAttempt[]; audit?: AuditOutput;
  review?: BatchHumanReview; reviewDigest?: string; reviewVerified?: boolean;
  score?: StageScore; auditScore?: AuditScore;
};
export type BatchHumanReview = { extraction: HumanJudgments; audit: AuditHumanRecords };
export type ReviewVerificationRequest = {
  kind: 'human-review' | 'reference-correction';
  /** Digest includes identity AND all judgment records, gold content/review and audit outputs. */
  digest: string; identity: unknown; contents: unknown;
};
export type BatchServices = {
  root: string; envNames: readonly string[];
  baselines: Record<ScoringStage, NonNullable<ExtractRequest['baseline']>>;
  projectId: string; auditSettings: Record<string, unknown>; pricing: BatchPricing; maxPolls: number;
  /** Return native single-attempt fetch and explicit key; keys never enter artifacts. */
  extraction: (route: BenchmarkRoute) => Pick<ExtractTransport, 'fetch' | 'apiKey'>;
  audit: {
    /** Native single HTTP call, honoring the supplied timeout signal. No internal retry. */
    complete: (request: AuditChunk & { route: BenchmarkRoute; settings: Record<string, unknown>; signal: AbortSignal }) => Promise<AuditReply>;
    /** Ephemeral audit key/header values for output redaction; never persisted. */
    redactValues?: readonly string[];
  };
  human?: (request: { run: BatchRun; pack: FrozenReferencePack }) => Promise<BatchHumanReview | null>;
  /** Caller authenticates an exact content digest using locally verified human evidence.
   * Returning true for identity labels alone violates this contract. Absent => provisional.
   */
  verifyReview?: (request: ReviewVerificationRequest) => Promise<boolean>;
  /** Trusted latest digest held outside editable checkpoint JSON. Required on resume. */
  resumeDigest?: string;
  /** Persist digest in a separate trusted caller channel; failure stops calls. */
  onCheckpoint?: (digest: string) => Promise<void>;
  /** Explicit reconciled external setup/tuning charges; null retains the configured reserve. */
  overheadCharges?: { setupUsd: number | null; tuningUsd: number | null };
  referenceCorrection?: { rationale: string; reviewerId: string; reviewedAt: string };
};
export type CostEntry = { id: string; runId: string; operation: string; boundUsd: number; costUsd: number | null; status: string; jobId?: string; usage: unknown };
type Allowance = { runId: string; operation: string; remaining: number; boundUsd: number };
type JobCharge = { jobId: string; costUsd: number | null; parseJobId: string | null; parseUsd: number | null; complete: boolean };
export type BatchCosts = { overheadCharges: { setupUsd: number | null; tuningUsd: number | null }; spentUsd: number; reservedUsd: number; remainingWorkUsd: number; conservativeTotalUsd: number; unknown: boolean; entries: CostEntry[]; jobs: JobCharge[] };
export type BatchResult = {
  status: 'completed' | 'incomplete'; batchId: string; checkpointDigest: string; artifactDirectory: string;
  reasons: string[]; runs: BatchRun[]; costs: BatchCosts; elapsedMs: number;
};
type Manifest = {
  protocol: 1; batchId: string; createdAt: string; updatedAt: string; elapsedMs: number;
  inputDigest: string; executionDigest: string; runtimeDigest: string;
  config: BenchmarkConfig; packs: FrozenReferencePack[];
  runs: BatchRun[]; allowances: Allowance[]; costs: CostEntry[]; jobs: JobCharge[];
  overheadCharges: { setupUsd: number | null; tuningUsd: number | null };
  retries: number; stopped: string | null; status: 'completed' | 'incomplete'; reasons: string[];
  history: { config: BenchmarkConfig; packs: FrozenReferencePack[]; evaluations: unknown; correction: unknown }[];
};
const stages: ScoringStage[] = ['need_extract', 'inventory_extract'];
const configurations = ['baseline', 'extract'] as const;
/** Require finite, explicit nonnegative amounts. */
function money(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n >= 0; }
/** Strict source/reference hash recomputation prevents attested labels hiding edits. */
function verifyPack(pack: FrozenReferencePack, config: BenchmarkConfig): void {
  const source = config.sources.find(s => s.packId === pack.packId);
  const { packHash, ...payload } = pack;
  if (!source || source.hash !== pack.originalFileHash || source.blocks !== pack.source.blocks.length || pack.sourceCodeVersion !== config.sourceCodeVersion || pack.referenceVersion !== config.referenceVersion || pack.sourceHash !== artifactDigest(pack.source) || pack.referenceHash !== artifactDigest({ packId: pack.packId, referenceVersion: pack.referenceVersion, gold: pack.gold }) || packHash !== artifactDigest(payload)) throw new Error('Frozen pack identity/content mismatch');
  // Prior scorer validates gold support, review version/loss IDs, and source quote links.
  if (Object.values(pack.gold).some(g => g.review.status !== 'approved')) throw new Error('Frozen gold review is pending; caller boolean is insufficient');
  for (const stage of stages) scoreStage(pack, stage, [], { identity: scoringIdentity(pack, stage, []), records: [] });
}
/** Requested execution settings exclude evaluator-only reference corrections. */
function executionDigest(config: BenchmarkConfig, packs: FrozenReferencePack[], runtimeDigest: string): string {
  const { referenceVersion: _referenceVersion, ...execution } = config;
  void _referenceVersion;
  return artifactDigest({ execution, runtimeDigest, sources: packs.map(p => ({ packId: p.packId, originalFileHash: p.originalFileHash, source: p.source, parserVersion: p.parserVersion, sourceCodeVersion: p.sourceCodeVersion })) });
}
/** Price every token attempt, including failures and shallow revisions; unknown retains reserve. */
function tokenCost(usage: unknown, pricing: BatchPricing): number | null {
  const u = usage as Record<string, unknown> | null;
  return u && money(u.input_tokens) && money(u.output_tokens) ? (u.input_tokens * pricing.inputUsdPerMillion + u.output_tokens * pricing.outputUsdPerMillion) / 1e6 : null;
}
/** Remove supplied extraction credentials and headers even if a transport reflects them. */
function redact<T>(value: T, secrets: Set<string>): T {
  if (typeof value === 'string') return [...secrets].filter(Boolean).reduce((v, key) => v.split(key).join('[REDACTED]'), value) as T;
  if (Array.isArray(value)) return value.map(v => redact(v, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), redact(v, secrets)])) as T;
  return value;
}
/** Conservative plan covers full matrix, possible revisions, bounded polls and retry reserve. */
function createPlan(runs: BatchRun[], packs: FrozenReferencePack[], services: BatchServices, config: BenchmarkConfig): Allowance[] {
  const p = services.pricing, plan: Allowance[] = [];
  for (const run of runs) {
    const add = (operation: string, remaining: number, boundUsd: number) => { plan.push({ runId: run.id, operation, remaining, boundUsd }); };
    if (run.configuration === 'baseline') add('baseline', services.baselines[run.stage].shallowCycle ? 2 : 1, p.baselineMaxUsd);
    else { add('upload', 1, p.uploadMaxUsd); add('submit', 1, p.extractJobMaxUsd); add('poll', services.maxPolls, 0); }
    add('audit', Math.ceil(packs.find(pack => pack.packId === run.packId)!.source.blocks.length / 25), p.auditMaxUsd);
  }
  if (config.maxTemporaryRetries) { plan.push({ runId: '*retry', operation: 'baseline', remaining: 2, boundUsd: p.baselineMaxUsd }, { runId: '*retry', operation: 'audit', remaining: 1, boundUsd: p.auditMaxUsd }); }
  return plan;
}
/** Combine cumulative extraction snapshots by job and shared parse identity, never by poll. */
function costLedger(manifest: Manifest): BatchCosts {
  const b = manifest.config.budget;
  const parses = new Map<string, number>();
  let jobsUsd = 0;
  for (const job of manifest.jobs) {
    jobsUsd += job.costUsd ?? 0;
    if (job.parseJobId && job.parseUsd !== null) parses.set(job.parseJobId, Math.max(parses.get(job.parseJobId) ?? 0, job.parseUsd));
  }
  const chargedEntries = manifest.costs.filter(e => e.operation === 'baseline' || e.operation === 'audit' || e.operation === 'upload');
  const overhead = manifest.overheadCharges;
  const spentUsd = b.spentUsd! + (overhead.setupUsd ?? 0) + (overhead.tuningUsd ?? 0) + jobsUsd + [...parses.values()].reduce((a, n) => a + n, 0) + chargedEntries.reduce((n, e) => n + (e.costUsd ?? 0), 0);
  const overheadReserve = (overhead.setupUsd === null ? b.setupUsd! : 0) + (overhead.tuningUsd === null ? b.tuningUsd! : 0);
  const reservedUsd = overheadReserve + manifest.costs.reduce((n, e) => {
    if (e.operation === 'submit') {
      const job = manifest.jobs.find(j => j.jobId === e.jobId);
      const known = (job?.costUsd ?? 0) + (job?.parseUsd ?? 0);
      return n + (job?.complete ? 0 : Math.max(0, e.boundUsd - known));
    }
    return n + (e.costUsd === null ? e.boundUsd : 0);
  }, 0);
  const remainingWorkUsd = manifest.allowances.reduce((n, a) => n + a.remaining * a.boundUsd, 0);
  const unknown = overhead.setupUsd === null || overhead.tuningUsd === null || manifest.costs.some(e => e.costUsd === null && !(e.operation === 'submit' && manifest.jobs.find(j => j.jobId === e.jobId)?.complete)) || manifest.jobs.some(j => !j.complete);
  return { overheadCharges: structuredClone(overhead), spentUsd, reservedUsd, remainingWorkUsd, conservativeTotalUsd: spentUsd + reservedUsd + remainingWorkUsd, unknown, entries: structuredClone(manifest.costs), jobs: structuredClone(manifest.jobs) };
}

/** Run/resume the complete frozen matrix in excluded private filesystem storage.
 * Throws before provider work on invalid inputs, lock contention, tampered checkpoints
 * or missing trusted resume digest. Returns explicit incomplete for retained failures,
 * bounded polling, costs/citations/routes/review pending. No automatic low-recall retry.
 * Reference corrections rescore EVERY saved output with fresh authenticated reviews;
 * prior packs, scores and review evidence remain in manifest history, without paid reruns.
 *
 * Local CLI human attestation (no external authentication infrastructure): first
 * retain each run.reviewDigest and inspect the exact source/gold, extraction
 * judgments and audit verdicts it binds. A human writes approved SHA-256 digests
 * to a separate operator-owned file/channel outside editable batch artifacts.
 * The CLI loads that allowlist explicitly and supplies verifyReview(req) as
 * `req.digest === artifactDigest(req.contents) && approved.has(req.digest)`.
 * Never generate approvals automatically from reviewerId/signature metadata.
 * Reference corrections require a NEW approval binding prior and next full pack
 * contents, correction rationale and reviewer; all run reviews need fresh digests.
 * Keep latest checkpointDigest separately (or use onCheckpoint to record it in
 * the trusted caller channel). Supply it as resumeDigest; a digest copied only
 * from editable manifest/report JSON is not authentication. A crash's exclusive
 * .lock stays fail-closed: an operator must confirm the recorded process has
 * terminated before removing ONLY the stale lock, retaining all checkpoints.
 * maxPolls is a lifetime per-run limit, including billing-only reconciliation.
 * Both audit routes use FROZEN_AUDIT_PROCESS_HASH and artifactDigest(auditSettings).
 * Baseline settings hashes cover snapshots/shallowCycle/baseUrl, excluding secret
 * headers; baselineSnapshot is artifactDigest(the two public baseline records).
 * Extract settings hash covers {version,tier,cite_sources}. Headers/project and
 * actual settings/prices/poll limits are additionally bound by runtimeDigest.
 * Pending nonzero setup/tuning bounds remain reserved until overheadCharges are
 * supplied; already known charges cannot be cleared or decreased on resume.
 * A transport must do exactly ONE HTTP call and honor its timeout signal; audit
 * HTTP failures may throw {temporary,httpStatus,raw,usage} to preserve/reconcile
 * vendor error usage. Only explicit temporary HTTP rejection may use the single
 * shared retry allowance; uncertain transport submissions and started attempts
 * are never replayed. Missing billing remains bounded, reserved and incomplete.
 * Stored artifacts: manifest.json (atomic authoritative checkpoint), interim.json,
 * final.json only when fully eligible (superseded marker otherwise), runs.csv,
 * findings.csv, attempts.csv, jobs.csv and interim-report.md. Prior final JSON is
 * archived on resume; reference history retains prior packs and every run review.
 * Job CSV charges exclude parse; shared parse IDs must be deduplicated in totals.
 * Audit reuses the existing 25-block batches and 2,000-character per-block prompt
 * limit equally for both extractors; source extraction itself is untruncated.
 */
export async function runBenchmarkBatch(configInput: BenchmarkConfig, packsInput: readonly FrozenReferencePack[], services: BatchServices): Promise<BatchResult> {
  const started = Date.now();
  const config = benchmarkConfigSchema.parse(structuredClone(configInput));
  const packs = structuredClone([...packsInput]);
  const preflight = checkPreflight(config, services.envNames);
  if (!preflight.ready) throw new Error(`Preflight blocked: ${preflight.blockers.join('; ')}`);
  if (packs.length !== config.sources.length || new Set(packs.map(p => p.packId)).size !== packs.length) throw new Error('Complete separate pack matrix required');
  packs.forEach(p => verifyPack(p, config));
  if (!Number.isInteger(services.maxPolls) || services.maxPolls < 1 || services.maxPolls > 100) throw new Error('Explicit bounded polling required');
  const pricing = structuredClone(services.pricing);
  if (pricing.asOf !== config.budget.priceAsOf || pricing.source !== config.budget.priceSource || Object.entries(pricing).some(([k, v]) => k !== 'asOf' && k !== 'source' && !money(v))) throw new Error('Explicit dated conservative prices required');
  if (config.auditProcessHash !== FROZEN_AUDIT_PROCESS_HASH) throw new Error('Audit process hash mismatch');
  const baselines = structuredClone(services.baselines), auditSettings = structuredClone(services.auditSettings);
  const publicBaselines = Object.fromEntries(stages.map(stage => { const { headers: _headers, ...baseline } = baselines[stage]; void _headers; return [stage, baseline]; }));
  if (config.baselineSnapshot !== artifactDigest(publicBaselines)) throw new Error('Actual baseline snapshot mismatch');
  for (const route of config.routes) {
    const settings = route.stage === 'completeness_audit' ? auditSettings : route.configuration === 'baseline' ? publicBaselines[route.stage] : { version: route.version, tier: route.tier, cite_sources: route.citationsEnabled };
    if (route.settingsHash !== artifactDigest(settings)) throw new Error('Frozen route settings/content mismatch');
  }
  const runtimeDigest = artifactDigest({ baselines, auditSettings, pricing, projectId: services.projectId, maxPolls: services.maxPolls });
  const inputDigest = artifactDigest({ config, packs, runtimeDigest });
  const currentExecutionDigest = executionDigest(config, packs, runtimeDigest);
  const storage = await PrivateBatchStorage.acquire(services.root, config.storage.path);
  let manifest: Manifest;
  let checkpointDigest = '';
  const secrets = new Set<string>([...stages.flatMap(s => Object.values(baselines[s].headers ?? {})), ...services.audit.redactValues ?? []]);
  try {
    const saved = await storage.read('manifest.json');
    if (saved) {
      manifest = JSON.parse(saved);
      if (!services.resumeDigest || artifactDigest(manifest) !== services.resumeDigest) throw new Error('Trusted latest resume digest required; checkpoint contents changed');
      if (manifest.protocol !== 1 || manifest.batchId !== config.batchId || manifest.executionDigest !== currentExecutionDigest || manifest.runtimeDigest !== runtimeDigest) throw new Error('Frozen execution/configuration changed');
      if (manifest.inputDigest !== inputDigest) {
        const correction = services.referenceCorrection;
        if (!correction || !correction.rationale.trim() || !correction.reviewerId.trim() || !Number.isFinite(Date.parse(correction.reviewedAt)) || config.referenceVersion === manifest.config.referenceVersion) throw new Error('Explicit reviewed full-matrix reference correction required');
        const contents = { prior: { config: manifest.config, packs: manifest.packs }, next: { config, packs }, correction };
        if (!services.verifyReview || !await services.verifyReview({ kind: 'reference-correction', digest: artifactDigest(contents), identity: { prior: manifest.inputDigest, next: inputDigest }, contents: structuredClone(contents) })) throw new Error('Reference correction authentication pending');
        manifest.history.push({ config: manifest.config, packs: manifest.packs, evaluations: manifest.runs.map(r => ({ id: r.id, score: r.score, auditScore: r.auditScore, review: r.review, reviewDigest: r.reviewDigest, reviewVerified: r.reviewVerified })), correction });
        manifest.config = config; manifest.packs = packs; manifest.inputDigest = inputDigest;
        for (const r of manifest.runs) { delete r.score; delete r.auditScore; delete r.review; delete r.reviewDigest; delete r.reviewVerified; }
      }
    } else {
      if (services.resumeDigest) throw new Error('Resume checkpoint missing');
      const runs: BatchRun[] = packs.flatMap(pack => stages.flatMap(stage => configurations.flatMap(configuration => Array.from({ length: config.repetitions }, (_, i) => ({ id: `${config.batchId}:${pack.packId}:${stage}:${configuration}:${i + 1}`, packId: pack.packId, stage, configuration, repetition: i + 1, route: config.routes.find(r => r.configuration === configuration && r.stage === stage)!, auditRoute: config.routes.find(r => r.configuration === configuration && r.stage === 'completeness_audit')!, extractionHistory: [], extractionElapsedMs: 0, retryUsed: false, polls: 0, auditAttempts: [] })))));
      manifest = { protocol: 1, batchId: config.batchId, createdAt: new Date().toISOString(), updatedAt: '', elapsedMs: 0, config, packs, inputDigest, executionDigest: currentExecutionDigest, runtimeDigest, runs, allowances: createPlan(runs, packs, { ...services, baselines, pricing }, config), costs: [], jobs: [], overheadCharges: { setupUsd: config.budget.setupUsd === 0 ? 0 : null, tuningUsd: config.budget.tuningUsd === 0 ? 0 : null }, retries: 0, stopped: null, status: 'incomplete', reasons: [], history: [] };
      if (costLedger(manifest).conservativeTotalUsd > config.budget.ceilingUsd) throw new Error('Derived full experiment reservations exceed ceiling');
      const planned = manifest.allowances.reduce((n, a) => n + a.remaining, 0), advertised = config.budget.calls.reduce((n, a) => n + a.count, 0);
      if (advertised < planned || config.budget.calls.reduce((n, a) => n + a.count * a.maxUsd!, 0) < manifest.allowances.reduce((n, a) => n + a.remaining * a.boundUsd, 0)) throw new Error('Preflight plan does not cover all actual operations/revisions/polls/retries');
    }
    if (services.overheadCharges) {
      for (const key of ['setupUsd', 'tuningUsd'] as const) {
        const amount = services.overheadCharges[key], previous = manifest.overheadCharges[key];
        if (amount !== null && !money(amount)) throw new Error('Invalid explicit overhead charge');
        if (previous !== null && (amount === null || amount < previous)) throw new Error('Known overhead charges cannot be discarded');
        manifest.overheadCharges[key] = amount;
        if (amount !== null && amount > config.budget[key]!) manifest.stopped = 'Known unexpected setup/tuning charge exceeds conservative bound';
      }
    }
    /** Persist checkpoint and trusted caller digest BEFORE any external action. */
    async function checkpoint() {
      manifest.updatedAt = new Date().toISOString();
      // Never persist transport keys/headers. Request headers are represented only by runtimeDigest.
      const safe = redact(manifest, secrets);
      checkpointDigest = artifactDigest(safe);
      await storage.write('manifest.json', JSON.stringify(safe, null, 2));
      const interimCosts = costLedger(manifest);
      await storage.write('interim-report.md', `# Benchmark ${config.batchId}\n\nStatus: **${manifest.status}**\n\nCompleted extractions: ${manifest.runs.filter(r => r.extraction?.status === 'completed').length}/${manifest.runs.length}.\n\nSpent: $${interimCosts.spentUsd}; reserved: $${interimCosts.reservedUsd}; remaining work: $${interimCosts.remainingWorkUsd}. Unknown billing: ${interimCosts.unknown}.\n\nCheckpoint: ${checkpointDigest}\n\n${manifest.stopped ?? 'Execution/review may still be pending; consult manifest.json.'}\n`);
      await services.onCheckpoint?.(checkpointDigest);
    }
    /** Reserve/record exactly one new operation, retaining all remaining work reserves. */
    async function before(run: BatchRun, id: string, operation: string, retry: boolean) {
      if (manifest.stopped || costLedger(manifest).conservativeTotalUsd > config.budget.ceilingUsd) throw new Error('Budget stopped');
      if (manifest.costs.some(e => e.id === id)) throw new Error('Attempt identity reused');
      const allowance = manifest.allowances.find(a => a.runId === (retry ? '*retry' : run.id) && a.operation === operation && a.remaining > 0);
      if (!allowance) throw new Error('No remaining operation reservation');
      allowance.remaining--;
      manifest.costs.push({ id, runId: run.id, operation, boundUsd: allowance.boundUsd, costUsd: operation === 'poll' || operation === 'upload' && allowance.boundUsd === 0 ? 0 : null, status: 'started', usage: null });
      await checkpoint();
    }
    /** Apply known token charge; unexpected charges immediately stop subsequent calls. */
    function reconcileToken(entry: CostEntry, usage: unknown) {
      entry.usage = usage;
      entry.costUsd = tokenCost(usage, pricing);
      if (entry.costUsd !== null && entry.costUsd > entry.boundUsd) manifest.stopped = 'Known unexpected charge exceeds conservative bound';
    }
    /** Reconcile every persisted extraction attempt, including failures/revisions. */
    function reconcileExtraction(run: BatchRun, state: ExtractState) {
      for (const attempt of state.attempts) {
        const entry = manifest.costs.find(e => e.id === attempt.id);
        if (!entry) throw new Error('Attempt checkpoint without reservation');
        entry.status = attempt.status; entry.usage = attempt.usage;
        if (attempt.operation === 'baseline') reconcileToken(entry, attempt.usage);
        if (attempt.operation === 'upload') {
          const u = attempt.usage as Record<string, unknown> | null;
          if (money(u?.credits)) { entry.costUsd = u.credits * 0.00125; if (entry.costUsd > entry.boundUsd) manifest.stopped = 'Known unexpected upload charge exceeds conservative bound'; }
        }
        if (attempt.operation === 'submit') entry.jobId = state.jobId ?? undefined;
      }
    }
    /** Reconcile latest JOB cumulative credits; shared parse billed once by parse_job_id. */
    function reconcileJob(run: BatchRun, result: ExtractResult) {
      if (!result.state.jobId) return;
      const u = result.usage as Record<string, unknown> | null;
      const jobId = result.state.jobId;
      if (manifest.costs.some(e => e.operation === 'submit' && e.jobId === jobId && e.runId !== run.id)) { manifest.stopped = 'Extraction job identity reused across separate runs'; return; }
      let job = manifest.jobs.find(j => j.jobId === jobId);
      if (!job) { job = { jobId, costUsd: null, parseJobId: null, parseUsd: null, complete: false }; manifest.jobs.push(job); }
      const latestRaw = result.rawOutputs.at(-1) as Record<string, unknown> | undefined;
      const usageParseId = typeof u?.parse_job_id === 'string' ? u.parse_job_id : null;
      const responseParseId = typeof latestRaw?.parse_job_id === 'string' ? latestRaw.parse_job_id : null;
      if (usageParseId && responseParseId && usageParseId !== responseParseId) { manifest.stopped = 'Conflicting shared parse billing identities'; return; }
      const parseId = usageParseId ?? responseParseId;
      const completeBilling = money(u?.credits) && money(u?.extract_credits) && money(u?.parse_credits) && u.credits >= u.parse_credits + u.extract_credits;
      if (completeBilling && (u!.parse_credits === 0 || parseId)) {
        const cost = (u!.credits as number - (u!.parse_credits as number)) * 0.00125;
        const parse = (u!.parse_credits as number) * 0.00125;
        if (job.costUsd !== null && cost < job.costUsd || job.parseUsd !== null && parse < job.parseUsd || job.parseJobId && job.parseJobId !== parseId) { manifest.stopped = 'Nonmonotonic or changed cumulative billing identity'; return; }
        job.costUsd = cost; job.parseUsd = parse; job.parseJobId = parseId;
        job.complete = result.status === 'completed' && result.costUsd !== null;
      } else {
        // Preserve known partial extraction charges, but retain unknown reserves.
        if (money(u?.extract_credits)) job.costUsd = Math.max(job.costUsd ?? 0, u.extract_credits * 0.00125);
        if (money(u?.parse_credits) && (u.parse_credits === 0 || parseId)) {
          if (job.parseJobId && job.parseJobId !== parseId) { manifest.stopped = 'Changed shared parse identity'; return; }
          job.parseJobId = parseId; job.parseUsd = Math.max(job.parseUsd ?? 0, u.parse_credits * 0.00125);
          if (money(u?.credits) && u.credits >= u.parse_credits) job.costUsd = Math.max(job.costUsd ?? 0, (u.credits - u.parse_credits) * 0.00125);
        }
        job.complete = false;
      }
      const lease = manifest.costs.find(e => e.runId === run.id && e.operation === 'submit');
      if (money(u?.parse_credits) && u.parse_credits > 0 && !parseId) manifest.stopped = 'Shared parse billing identity is missing; costs cannot be reconciled';
      const reportedLowerBound = Math.max(money(u?.credits) ? u.credits : 0, (money(u?.extract_credits) ? u.extract_credits : 0) + (money(u?.parse_credits) ? u.parse_credits : 0)) * 0.00125;
      if (lease && ((job.costUsd ?? 0) + (job.parseUsd ?? 0) > lease.boundUsd || reportedLowerBound > lease.boundUsd)) manifest.stopped = 'Known unexpected job charge exceeds conservative bound';
    }
    /** Completed operations no longer reserve unused revisions or audit chunks. */
    function release(run: BatchRun, operations: string[]) { for (const allowance of manifest.allowances) if (allowance.runId === run.id && operations.includes(allowance.operation)) allowance.remaining = 0; }
    manifest.status = 'incomplete';
    if (saved && await storage.read('final.json')) {
      const priorFinal = (await storage.read('final.json'))!;
      await storage.write(`prior-final-${services.resumeDigest}.json`, priorFinal);
      await storage.write('final.json', JSON.stringify({ status: 'superseded', reason: 'Resume/full-matrix review in progress; prior final retained' }));
    }
    await checkpoint();
    for (const run of manifest.runs) {
      const pack = packs.find(p => p.packId === run.packId)!;
      if (manifest.stopped) break;
      // A started HTTP attempt may have been charged: never silently replay it.
      if (run.extractionState?.attempts.some(a => a.status === 'started') || manifest.costs.some(e => e.runId === run.id && e.operation !== 'audit' && e.status === 'started' && !run.extractionState?.attempts.some(a => a.id === e.id))) { manifest.reasons.push(`${run.id}: interrupted potentially charged extraction`); continue; }
      let retry = run.retryUsed;
      const billingPending = run.configuration === 'extract' && !!run.extractionState?.jobId && !manifest.jobs.find(j => j.jobId === run.extractionState!.jobId)?.complete;
      if (!run.extraction || run.extraction.status === 'pending' || run.extractionState?.jobId && run.extraction.error?.temporary || run.extraction?.status === 'completed' && billingPending) {
        const transport = services.extraction(structuredClone(run.route)); secrets.add(transport.apiKey);
        let result: ExtractResult;
        do {
          const previous = run.extractionState;
          const isPoll = !!previous?.jobId;
          if (isPoll && run.polls >= services.maxPolls) break;
          if (isPoll) run.polls++;
          result = await extractStage({ runId: run.id, attemptId: `${run.id}:extract:${retry ? 'retry' : 'initial'}`, pack: { packId: pack.packId, sourceHash: pack.sourceHash, source: pack.source }, route: run.route, projectId: services.projectId, baseline: run.configuration === 'baseline' ? baselines[run.stage] : undefined, resume: previous }, {
            ...transport,
            beforeAttempt: async (attempt, state) => {
              // Persist reservation AND opaque state even when interrupted before adapter checkpoint.
              run.extractionState = state;
              await before(run, attempt.id, attempt.operation, retry);
              run.extractionState = { ...state, attempts: [...state.attempts, attempt], submissionUncertain: state.submissionUncertain || attempt.operation === 'submit' };
              await checkpoint();
            },
            checkpoint: async state => { run.extractionState = state; reconcileExtraction(run, state); await checkpoint(); },
          });
          run.extractionElapsedMs += result.elapsedMs;
          if (run.extraction?.status === 'completed' && result.status === 'completed' && artifactDigest(run.extraction.findings) !== artifactDigest(result.findings)) {
            manifest.stopped = 'Completed job findings changed during billing reconciliation'; run.extractionHistory.push(result);
          } else if (run.extraction?.status === 'completed' && result.status !== 'completed') {
            run.extractionHistory.push(result); // billing-poll failures never discard verified completed findings
          } else run.extraction = result;
          run.extractionState = result.state;
          reconcileExtraction(run, result.state); if (run.configuration === 'extract') reconcileJob(run, result);
          await checkpoint();
          // Only explicit rejected temporary baseline calls can start one labelled retry.
          // Transport uncertainty or partial successful drafts cannot be replayed.
          if (result.status === 'failed' && run.configuration === 'baseline' && result.error?.temporary && result.error.httpStatus !== null && result.attempts.every(a => a.status === 'failed') && !retry && manifest.retries < config.maxTemporaryRetries && !manifest.stopped) {
            manifest.retries++; run.retryUsed = true; retry = true; run.extractionHistory.push(result); delete run.extractionState; delete run.extraction; await checkpoint(); continue;
          }
          if (result.status !== 'pending') break;
        } while (!manifest.stopped);
      }
      if (run.extraction?.status !== 'completed') continue;
      release(run, ['baseline', 'upload', 'submit']);
      if (run.configuration === 'baseline' || manifest.jobs.find(j => j.jobId === run.extractionState?.jobId)?.complete) release(run, ['poll']);
      if (manifest.stopped) break;
      const chunks = prepareAudit({ packId: pack.packId, source: pack.source }, run.stage, run.extraction.findings);
      for (const chunk of chunks) {
        if (manifest.stopped) break;
        let retryAudit = false;
        do {
          const prior = run.auditAttempts.filter(a => a.chunkId === chunk.id);
          if (prior.some(a => a.status === 'completed' && a.verdicts)) break;
          if (prior.length) {
            const last = prior.at(-1)!;
            if (last.status !== 'failed' || !last.temporary || last.httpStatus === null || last.httpStatus === undefined || manifest.retries >= config.maxTemporaryRetries) break;
            manifest.retries++; retryAudit = true;
          }
          const attempt: AuditAttempt = { id: `${run.id}:audit:${run.auditAttempts.length + 1}`, chunkId: chunk.id, startedAt: new Date().toISOString(), elapsedMs: 0, status: 'started' };
          run.auditAttempts.push(attempt);
          await before(run, attempt.id, 'audit', retryAudit);
          const began = Date.now();
          try {
            const reply = await services.audit.complete({ ...structuredClone({ ...chunk, route: run.auditRoute, settings: auditSettings }), signal: AbortSignal.timeout(60_000) });
            attempt.raw = redact(reply.raw, secrets); attempt.usage = redact(reply.usage, secrets);
            attempt.actual = redact({ providerId: reply.providerId, model: reply.model, settingsHash: reply.settingsHash }, secrets);
            const entry = manifest.costs.find(e => e.id === attempt.id)!;
            reconcileToken(entry, attempt.usage);
            if (reply.providerId !== run.auditRoute.providerId || reply.model !== run.auditRoute.requestedModel || reply.settingsHash !== run.auditRoute.settingsHash) { attempt.error = 'audit_route_substituted'; throw new Error('Unverified audit'); }
            attempt.verdicts = validateAudit(chunk, attempt.raw); attempt.status = 'completed';
          } catch (error) {
            attempt.status = 'failed'; attempt.error ??= 'audit_failed_or_invalid_response';
            const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {};
            attempt.httpStatus = typeof failure.httpStatus === 'number' ? failure.httpStatus : null;
            attempt.temporary = failure.temporary === true && [408, 429, 500, 502, 503, 504].includes(attempt.httpStatus ?? 0);
            if (failure.raw !== undefined) attempt.raw = redact(failure.raw, secrets);
            if (failure.usage !== undefined) { attempt.usage = redact(failure.usage, secrets); reconcileToken(manifest.costs.find(e => e.id === attempt.id)!, attempt.usage); }
          } finally {
            attempt.elapsedMs = Date.now() - began;
            manifest.costs.find(e => e.id === attempt.id)!.status = attempt.status;
            await checkpoint();
          }
          if (attempt.status === 'completed' || !attempt.temporary || manifest.stopped) break;
        } while (manifest.retries < config.maxTemporaryRetries);
      }
      run.audit = auditOutput({ packId: pack.packId, source: pack.source }, chunks, run.auditAttempts.flatMap(a => a.status === 'completed' ? a.verdicts ?? [] : []));
      if (run.audit.complete) release(run, ['audit']);
      const supplied = await services.human?.({ run: structuredClone(run), pack: structuredClone(pack) });
      if (supplied) run.review = structuredClone(supplied);
      const judgments = run.review?.extraction ?? { identity: scoringIdentity(pack, run.stage, run.extraction.findings), records: [] };
      const score = scoreStage(pack, run.stage, run.extraction.findings, judgments);
      run.auditScore = scoreAudit(run.audit, score.omissions, run.review?.audit ?? null);
      const contents = { runId: run.id, extractionRoute: run.route, identity: score.identity, extractionRecords: judgments.records, gold: pack.gold, audit: run.audit, auditRecords: run.review?.audit ?? null, auditRoute: run.auditRoute, processHash: config.auditProcessHash };
      const digest = artifactDigest(contents);
      run.reviewDigest = digest;
      run.reviewVerified = !!run.review && !!services.verifyReview && await services.verifyReview({ kind: 'human-review', digest, identity: score.identity, contents: structuredClone(contents) });
      score.provisional ||= !run.reviewVerified; run.auditScore.provisional ||= !run.reviewVerified;
      run.score = score;
      await checkpoint();
    }
    const matrixComplete = manifest.runs.every(r => r.extraction?.status === 'completed' && r.audit?.complete);
    if (matrixComplete) for (const a of manifest.allowances) if (a.runId === '*retry') a.remaining = 0;
    const costs = costLedger(manifest);
    manifest.reasons = [];
    if (manifest.stopped) manifest.reasons.push(manifest.stopped);
    for (const run of manifest.runs) {
      if (run.extraction?.status !== 'completed') manifest.reasons.push(`${run.id}: extraction ${run.extraction?.status ?? 'interrupted/not started'}`);
      if (run.extraction?.actualRoute.label !== 'verified') manifest.reasons.push(`${run.id}: extraction response route unverified`);
      if (run.score?.citationValidity.numerator !== run.score?.citationValidity.denominator || run.extraction?.findings.some(f => !f.citation.valid)) manifest.reasons.push(`${run.id}: invalid source citations`);
      if (!run.audit?.complete) manifest.reasons.push(`${run.id}: incomplete audit`);
      if (!run.score || run.score.provisional || !run.auditScore || run.auditScore.provisional) manifest.reasons.push(`${run.id}: human review pending`);
    }
    if (costs.unknown) manifest.reasons.push('Unreconciled potentially charged attempts/job costs');
    if (costs.conservativeTotalUsd > config.budget.ceilingUsd) manifest.reasons.push('Whole experiment budget exceeded');
    manifest.status = manifest.reasons.length ? 'incomplete' : 'completed';
    manifest.elapsedMs += Date.now() - started;
    await checkpoint();
    const result: BatchResult = { status: manifest.status, batchId: config.batchId, checkpointDigest, artifactDirectory: storage.directory, reasons: manifest.reasons, runs: structuredClone(manifest.runs), costs, elapsedMs: manifest.elapsedMs };
    await storage.write('interim.json', JSON.stringify(redact({ ...result, config, packs, history: manifest.history }, secrets), null, 2));
    const rows: unknown[][] = [['run_id', 'pack_id', 'stage', 'configuration', 'repeat', 'content_recall', 'citation_validity', 'content_with_citation', 'provisional', 'job_id', 'extraction_ms', 'audit_ms', 'source_hash', 'reference_hash', 'settings_hash', 'requested_provider', 'requested_model', 'actual_model', 'actual_version', 'actual_tier', 'audit_process_hash', 'review_digest']];
    const findings: unknown[][] = [['run_id', 'kind', 'id', 'statement_or_reason', 'quotes', 'review']];
    for (const run of manifest.runs) {
      rows.push([run.id, run.packId, run.stage, run.configuration, run.repetition, run.score?.contentRecall.percent, run.score?.citationValidity.percent, run.score?.contentWithCitation.percent, run.score?.provisional, run.extractionState?.jobId, run.extractionElapsedMs, run.auditAttempts.reduce((n, a) => n + a.elapsedMs, 0), packs.find(p => p.packId === run.packId)!.sourceHash, packs.find(p => p.packId === run.packId)!.referenceHash, run.route.settingsHash, run.route.providerId, run.route.requestedModel, run.extraction?.actualRoute.model, run.extraction?.actualRoute.version, run.extraction?.actualRoute.tier, config.auditProcessHash, run.reviewDigest]);
      for (const f of run.extraction?.findings ?? []) findings.push([run.id, 'extraction', f.id, f.statement, JSON.stringify(f.provenance), JSON.stringify(run.score?.items.find(i => i.findingId === f.id)?.judgment ?? null)]);
      for (const f of run.audit?.flags ?? []) findings.push([run.id, 'audit_flag', f.block_id, f.reason, f.excerpt, JSON.stringify(run.review?.audit.flags.find(r => r.blockId === f.block_id) ?? null)]);
    }
    const attempts: unknown[][] = [['run_id', 'attempt_id', 'operation', 'status', 'bound_usd', 'attempt_cost_usd', 'job_id', 'elapsed_ms', 'usage']];
    for (const entry of manifest.costs) {
      const run = manifest.runs.find(r => r.id === entry.runId)!;
      const attempt = run.extractionState?.attempts.find(a => a.id === entry.id) ?? run.extractionHistory.flatMap(r => r.attempts).find(a => a.id === entry.id) ?? run.auditAttempts.find(a => a.id === entry.id);
      attempts.push([entry.runId, entry.id, entry.operation, entry.status, entry.boundUsd, entry.costUsd, entry.jobId, attempt?.elapsedMs, JSON.stringify(entry.usage)]);
    }
    const jobs: unknown[][] = [['job_id', 'cumulative_job_usd_excluding_parse', 'parse_job_id', 'cumulative_parse_usd', 'billing_complete']];
    for (const job of manifest.jobs) jobs.push([job.jobId, job.costUsd, job.parseJobId, job.parseUsd, job.complete]);
    await storage.write('attempts.csv', analysisCsv(attempts)); await storage.write('jobs.csv', analysisCsv(jobs));
    await storage.write('runs.csv', analysisCsv(rows)); await storage.write('findings.csv', analysisCsv(findings));
    await storage.write('interim-report.md', `# Benchmark ${config.batchId}\n\nStatus: **${result.status}**\n\n${manifest.runs.length} planned separate runs; ${manifest.runs.filter(r => r.extraction?.status === 'completed').length} completed extractions.\n\nSpent: $${costs.spentUsd}; reserved: $${costs.reservedUsd}; remaining work: $${costs.remainingWorkUsd}. Unknown billing: ${costs.unknown}.\n\nAudit warnings are not recovered extraction findings. Human adoption/deployment remains separate.\n\n${result.reasons.map(r => `- ${r}`).join('\n')}\n`);
    if (result.status === 'completed') await storage.write('final.json', JSON.stringify(redact({ ...result, config, packs, history: manifest.history }, secrets), null, 2));
    else if (await storage.read('final.json')) await storage.write('final.json', JSON.stringify({ status: 'superseded', checkpointDigest, reason: 'Full matrix/reference review is pending; prior evidence retained in manifest history' }, null, 2));
    return result;
  } finally { await storage.close(); }
}
