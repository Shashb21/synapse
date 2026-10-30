/** Durable independent evaluator jobs with immutable manifests, receipts and terminal results. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { DevelopmentError, type DevelopmentDocument, type DevelopmentSection } from './schema';
import { ensureExecutionTables, type CallReceipt, type ExecutionCall, type ExecutionManifest } from './execution-store';
import type { EvaluationConfig } from './evaluation-schema';
import type { EvaluationProfile, Criterion } from './profile-schema';
import type { DevelopmentSectionResult } from './stage-execution';
import type { FrozenRoute } from './routes';
import type { LlmRequest } from '@/modules/llm/provider';
export type EvaluationStatus = 'queued' | 'running' | 'sending' | 'received' | 'succeeded' | 'failed' | 'needs_attention';
export type ReferenceItem = { id: string; answer: unknown };
export type EvaluationManifest = {
  version: 1; execution_id: string; attempt_id: string; output_id: string; section: DevelopmentSection;
  profile: EvaluationProfile; criteria: Criterion[]; config: EvaluationConfig; route: FrozenRoute | null;
  generation: ExecutionManifest; output: DevelopmentSectionResult; sources: DevelopmentDocument[]; references: DevelopmentDocument[];
  reference_items: ReferenceItem[]; reference_issues: string[]; reference_requested: boolean;
  code_identity: string; request: LlmRequest | null;
  retry_policy: { http_max_attempts: 1; uncertain_resend: false };
};
export type FactualChecks = { passed: boolean; items: { id: string; passed: boolean; detail: string }[] };
export type RatioMeasure = { numerator: number; denominator: number; value: number | null };
export type EvaluationResult = {
  checks: FactualChecks;
  rubric: { label: 'provisional_ai_assessment'; score: number; criteria: { criterion_id: string; score: number; reason: string; threshold_met: boolean | null }[]; factual_checks_passed: boolean } | null;
  reference: { label: 'provisional_semantic_reference'; status: 'scored' | 'unscored'; reasons: string[]; precision: RatioMeasure; recall: RatioMeasure; matches: { output_id: string; reference_id: string; reason: string }[]; unmatched_output_ids: string[]; unmatched_reference_ids: string[] };
};
export type Evaluation = { id: string; experiment_id: string; manifest: EvaluationManifest; status: EvaluationStatus; result: EvaluationResult | null; receipt: CallReceipt | null; failure_accounting: ExecutionCall['failure_accounting']; error: string | null; created_at: string; updated_at: string; sending_at: string | null; settled_at: string | null };
let ready: Promise<void> | undefined;
/** Install additive evaluation storage, serializing DDL across worker and API processes. */
export async function ensureEvaluationTables(): Promise<void> {
  ready ??= (async () => { await ensureExecutionTables(); await sharedDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('development-evaluation-schema'))`);
    await tx.execute(sql`create table if not exists development_evaluations (id text primary key, experiment_id text not null references development_experiments(id), manifest jsonb not null, status text not null check(status in ('queued','running','sending','received','succeeded','failed','needs_attention')), result jsonb, receipt jsonb, failure_accounting jsonb, error text, created_at text not null, updated_at text not null, sending_at timestamptz, settled_at timestamptz, claim_token text, claim_until timestamptz)`);
    await tx.execute(sql`create index if not exists development_evaluation_queue on development_evaluations(status,created_at)`);
    await tx.execute(sql`create or replace function development_evaluation_immutable() returns trigger language plpgsql as $$ begin if TG_OP='DELETE' then raise exception 'evaluation history is immutable'; end if; if NEW.manifest is distinct from OLD.manifest or NEW.experiment_id is distinct from OLD.experiment_id or NEW.id is distinct from OLD.id or NEW.created_at is distinct from OLD.created_at or OLD.status in ('succeeded','failed','needs_attention') or (OLD.receipt is not null and NEW.receipt is distinct from OLD.receipt) then raise exception 'evaluation history is immutable'; end if; return NEW; end $$`);
    await tx.execute(sql`do $$ begin if not exists(select 1 from pg_trigger where tgname='development_evaluation_immutable_trigger') then create trigger development_evaluation_immutable_trigger before update or delete on development_evaluations for each row execute function development_evaluation_immutable(); end if; end $$`);
  }); })().catch(error => { ready = undefined; throw error; }); await ready;
}
/** Persist the complete evaluator request before any worker can dispatch it. */
export async function reserveEvaluation(experimentId: string, manifest: EvaluationManifest): Promise<Evaluation> {
  await ensureEvaluationTables(); const id = randomUUID(), at = new Date().toISOString();
  await sharedDb().execute(sql`insert into development_evaluations(id,experiment_id,manifest,status,created_at,updated_at) values(${id},${experimentId},${JSON.stringify(manifest)}::jsonb,'queued',${at},${at})`);
  return getEvaluation(experimentId, id);
}
/** Read a private job only in its experiment; lease tokens never leave the store. */
export async function getEvaluation(experimentId: string, id: string): Promise<Evaluation> {
  await ensureEvaluationTables(); const rows = await sharedDb().execute(sql`select * from development_evaluations where id=${id} and experiment_id=${experimentId}`);
  if (!rows[0]) throw new DevelopmentError(404, 'evaluation_not_found', 'That evaluation does not belong to this experiment.');
  const { claim_token: token, claim_until: until, ...record } = rows[0]; void token; void until; return record as unknown as Evaluation;
}
/** Return bounded recent history; database history remains append-only. */
export async function listEvaluations(experimentId: string): Promise<Evaluation[]> {
  await ensureEvaluationTables(); const rows = await sharedDb().execute(sql`select id from development_evaluations where experiment_id=${experimentId} order by created_at desc limit 100`);
  return Promise.all(rows.map(row => getEvaluation(experimentId, row.id as string)));
}
/** Read durable evaluations for the exact attempts displayed, including older records. */
export async function listAttemptEvaluations(experimentId: string, attemptIds: string[]): Promise<Evaluation[]> {
  if (!attemptIds.length) return [];
  await ensureEvaluationTables();
  const rows = await sharedDb().execute(sql`select id from development_evaluations where experiment_id=${experimentId} and manifest->>'attempt_id' in ${sql`(${sql.join(attemptIds.map(id => sql`${id}`), sql`, `)})`} order by created_at desc, id desc`);
  return Promise.all(rows.map(row => getEvaluation(experimentId, row.id as string)));
}
/** Atomically own one job, preserving a sending marker across expired-lease recovery. */
export async function claimEvaluation(id?: string): Promise<{ evaluation: Evaluation; token: string } | null> {
  await ensureEvaluationTables(); const token = randomUUID();
  const rows = await sharedDb().execute(sql`update development_evaluations set claim_token=${token},claim_until=now()+interval '300 seconds',status=case when status='queued' then 'running' else status end where id=(select id from development_evaluations where status in ('queued','running','sending','received') and (${id ?? null}::text is null or id=${id ?? null}) and (claim_until is null or claim_until<now()) order by created_at for update skip locked limit 1) returning id,experiment_id`);
  return rows[0] ? { token, evaluation: await getEvaluation(rows[0].experiment_id as string, rows[0].id as string) } : null;
}
/** Fail closed when a worker no longer owns the lease immediately before dispatch. */
export async function requireEvaluationClaim(id: string, token: string): Promise<void> {
  const rows = await sharedDb().execute(sql`select id from development_evaluations where id=${id} and claim_token=${token} and claim_until>now() and status in ('running','sending','received')`);
  if (!rows[0]) throw new DevelopmentError(409, 'claim_lost', 'Evaluation worker ownership expired; do not resend.');
}
/** Only one worker can commit a sending marker for this evaluation. */
export async function beginEvaluationSend(id: string, token: string): Promise<void> {
  const rows = await sharedDb().execute(sql`update development_evaluations set status='sending',sending_at=now() where id=${id} and status='running' and claim_token=${token} and claim_until>now() returning id`);
  if (!rows[0]) throw new DevelopmentError(409, 'dispatch_conflict', 'This evaluation cannot be dispatched again.');
}
/** Persist raw receipt and accounting separately from reply parsing or result publication. */
export async function settleEvaluationReceipt(id: string, token: string, receipt: CallReceipt | null, error: string | null = null, failure: ExecutionCall['failure_accounting'] = null): Promise<void> {
  const rows = await sharedDb().execute(sql`update development_evaluations set status='received',receipt=${receipt ? JSON.stringify(receipt) : null}::jsonb,error=${error},failure_accounting=${failure ? JSON.stringify(failure) : null}::jsonb,settled_at=now() where id=${id} and status='sending' and claim_token=${token} and claim_until>now() returning id`);
  if (!rows[0]) throw new DevelopmentError(409, 'receipt_unsettled', 'Provider acceptance is uncertain because its evaluation receipt could not be settled. No automatic resend.');
}
/** Publish a terminal result or yield a settled receipt; terminal records cannot be changed again. */
export async function releaseEvaluation(id: string, token: string, status: 'queued' | 'received' | 'succeeded' | 'failed' | 'needs_attention', result: EvaluationResult | null, error: string | null = null): Promise<void> {
  const rows = await sharedDb().execute(sql`update development_evaluations set status=${status},result=${result ? JSON.stringify(result) : null}::jsonb,error=${error},updated_at=${new Date().toISOString()},claim_token=null,claim_until=null where id=${id} and claim_token=${token} and claim_until>now() returning id`);
  if (!rows[0]) throw new DevelopmentError(409, 'claim_lost', 'Evaluation publication lost worker ownership.');
}
