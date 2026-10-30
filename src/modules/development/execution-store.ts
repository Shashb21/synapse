/** Durable immutable execution manifests and atomic worker/call claims in the shared experiment schema. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import type { RawCompletionCall } from '@/modules/kernel/routing';
import type { LlmUsage } from '@/modules/llm/provider';
import type { DevelopmentDocument, DevelopmentSection } from './schema';
import { DevelopmentError } from './schema';
import type { ExecutionConfig } from './execution-schema';
import type { DevelopmentSectionResult, SectionModuleIdentity, SectionPromptIdentity } from './stage-execution';
import type { FrozenRoute, FrozenRoutes } from './routes';
import { ensureDevelopmentTables } from './store';
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_attention';
export type SectionStatus = 'queued' | 'running' | 'succeeded' | 'rejected' | 'not_applicable' | 'blocked' | 'failed';
export type Prerequisite = { attempt_id: string; output_id: string; result: DevelopmentSectionResult };
export type ExecutionManifest = {
  revision: number; target: 'all' | DevelopmentSection; config: ExecutionConfig;
  sources: DevelopmentDocument[]; routes: FrozenRoutes; code_identity: string;
  modules: Record<DevelopmentSection, SectionModuleIdentity>;
  prompts: Record<DevelopmentSection, SectionPromptIdentity>;
  prerequisites: Partial<Record<DevelopmentSection, Prerequisite>>;
  retry_policy: { http_max_attempts: 1; uncertain_resend: false; user_rerun: 'fresh_attempt_may_charge' };
};
export type SectionAttempt = { id: string; execution_id: string; experiment_id: string; section: DevelopmentSection; ordinal: number; status: SectionStatus; result: DevelopmentSectionResult | null; error: string | null; created_at: string; prerequisites: Partial<Record<DevelopmentSection, string>> };
export type CallReceipt = { text: string; usage: LlmUsage | null; cost_usd: number | null; price_source: string | null; llm_call_id: string | null };
export type ExecutionCall = { id: string; execution_id: string; section_id: string; ordinal: number; identity: string; request: RawCompletionCall; route: FrozenRoute; status: 'queued' | 'sending' | 'succeeded' | 'failed' | 'needs_attention'; receipt: CallReceipt | null; error: string | null; failure_accounting: Pick<CallReceipt, 'usage' | 'cost_usd' | 'price_source'> | null; created_at: string; sending_at: string | null; settled_at: string | null };
export type Execution = { id: string; experiment_id: string; manifest: ExecutionManifest; generation_status: GenerationStatus; evaluation_status: 'not_requested'; created_at: string; updated_at: string; error: string | null; sections: SectionAttempt[]; calls: ExecutionCall[] };
const DDL = [
  `CREATE TABLE IF NOT EXISTS development_executions (id text PRIMARY KEY, experiment_id text NOT NULL REFERENCES development_experiments(id), manifest jsonb NOT NULL, generation_status text NOT NULL CHECK(generation_status IN ('queued','running','succeeded','failed','needs_attention')), evaluation_status text NOT NULL DEFAULT 'not_requested' CHECK(evaluation_status='not_requested'), created_at text NOT NULL, updated_at text NOT NULL, error text, claim_token text, claim_until timestamptz)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS development_execution_one_active ON development_executions(experiment_id) WHERE generation_status IN ('queued','running')`,
  `CREATE TABLE IF NOT EXISTS development_execution_sections (id text PRIMARY KEY, execution_id text NOT NULL REFERENCES development_executions(id), experiment_id text NOT NULL REFERENCES development_experiments(id), section text NOT NULL, created_seq bigserial NOT NULL, ordinal integer NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','succeeded','rejected','not_applicable','blocked','failed')), result jsonb, error text, created_at text NOT NULL, prerequisites jsonb NOT NULL DEFAULT '{}', UNIQUE(execution_id,section))`,
  `ALTER TABLE development_execution_sections ADD COLUMN IF NOT EXISTS created_seq bigserial`,
  `CREATE INDEX IF NOT EXISTS development_section_history ON development_execution_sections(experiment_id,section,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS development_execution_calls (id text PRIMARY KEY, execution_id text NOT NULL REFERENCES development_executions(id), section_id text NOT NULL REFERENCES development_execution_sections(id), ordinal integer NOT NULL, identity text NOT NULL, request jsonb NOT NULL, route jsonb NOT NULL, status text NOT NULL CHECK(status IN ('queued','sending','succeeded','failed','needs_attention')), receipt jsonb, error text, failure_accounting jsonb, created_at timestamptz NOT NULL DEFAULT now(), sending_at timestamptz, settled_at timestamptz, UNIQUE(section_id,ordinal))`,
  `ALTER TABLE development_execution_calls ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS sending_at timestamptz, ADD COLUMN IF NOT EXISTS settled_at timestamptz`,
  `CREATE OR REPLACE FUNCTION development_manifest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id THEN RAISE EXCEPTION 'execution manifest is immutable'; END IF; RETURN NEW; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='development_manifest_immutable_trigger') THEN CREATE TRIGGER development_manifest_immutable_trigger BEFORE UPDATE ON development_executions FOR EACH ROW EXECUTE FUNCTION development_manifest_immutable(); END IF; END $$`,
];
let ready: Promise<void> | undefined;
/** Install additive experiment tables only; a failed initialization can be retried safely. */
export async function ensureExecutionTables(): Promise<void> {
  ready ??= (async () => { await ensureDevelopmentTables(); await sharedDb().transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtext('development-execution-schema'))`); for (const ddl of DDL) await tx.execute(sql.raw(ddl)); }); })().catch(error => { ready = undefined; throw error; });
  await ready;
}
/** Serialize publication with draft writes and bind current successful prerequisite attempts. */
export async function reserveExecution(experimentId: string, revision: number, sections: DevelopmentSection[], build: (history: (SectionAttempt & { manifest: ExecutionManifest })[]) => ExecutionManifest): Promise<Execution> {
  await ensureExecutionTables();
  const id = randomUUID();
  await sharedDb().transaction(async tx => {
    const draft = await tx.execute(sql`select revision from development_experiments where id=${experimentId} for update`);
    if (!draft[0]) throw new DevelopmentError(404, 'not_found', 'That experiment does not exist.');
    if (draft[0].revision !== revision) throw new DevelopmentError(409, 'stale_revision', 'The draft changed. Reload it before starting an execution.');
    const active = await tx.execute(sql`select id from development_executions where experiment_id=${experimentId} and generation_status in ('queued','running')`);
    if (active[0]) throw new DevelopmentError(409, 'execution_conflict', 'An execution is already active. Wait for its result before starting a fresh attempt.');
    const history = await tx.execute(sql`select s.*, e.manifest from development_execution_sections s join development_executions e on e.id=s.execution_id where s.experiment_id=${experimentId} order by s.created_seq desc`);
    const manifest = build(history as unknown as (SectionAttempt & { manifest: ExecutionManifest })[]);
    const at = new Date().toISOString();
    await tx.execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at) values(${id},${experimentId},${JSON.stringify(manifest)}::jsonb,'queued',${at},${at})`);
    for (const [ordinal, section] of sections.entries()) await tx.execute(sql`insert into development_execution_sections(id,execution_id,experiment_id,section,ordinal,status,created_at) values(${randomUUID()},${id},${experimentId},${section},${ordinal},'queued',${at})`);
  });
  return getExecution(experimentId, id);
}
/** Load an execution only within its authenticated experiment, including private request receipts. */
export async function getExecution(experimentId: string, id: string): Promise<Execution> {
  await ensureExecutionTables();
  const rows = await sharedDb().execute(sql`select * from development_executions where id=${id} and experiment_id=${experimentId}`);
  if (!rows[0]) throw new DevelopmentError(404, 'not_found', 'That execution does not belong to this experiment.');
  const sections = await sharedDb().execute(sql`select * from development_execution_sections where execution_id=${id} order by ordinal`);
  const calls = await sharedDb().execute(sql`select * from development_execution_calls where execution_id=${id} order by section_id,ordinal`);
  const { claim_token: ignoredToken, claim_until: ignoredUntil, ...record } = rows[0];
  void ignoredToken; void ignoredUntil;
  return { ...record, sections, calls } as unknown as Execution;
}
/** Return bounded recent immutable history, preserving all database attempts. */
export async function listExecutions(experimentId: string): Promise<Execution[]> {
  await ensureExecutionTables();
  const rows = await sharedDb().execute(sql`select id from development_executions where experiment_id=${experimentId} order by created_at desc limit 50`);
  return Promise.all(rows.map(row => getExecution(experimentId, row.id as string)));
}
export const CLAIM_SECONDS = 300;
/** Claim one recoverable execution; expired sending rows are never returned to the send queue. */
export async function claimExecution(id?: string): Promise<{ execution: Execution; token: string } | null> {
  await ensureExecutionTables();
  const token = randomUUID();
  const rows = await sharedDb().execute(sql`update development_executions set claim_token=${token},claim_until=now()+${CLAIM_SECONDS}*interval '1 second',generation_status='running',updated_at=${new Date().toISOString()} where id=(select id from development_executions where generation_status in ('queued','running') and (${id ?? null}::text is null or id=${id ?? null}) and (claim_until is null or claim_until<now()) order by created_at for update skip locked limit 1) returning id,experiment_id`);
  if (!rows[0]) return null;
  return { execution: await getExecution(rows[0].experiment_id as string, rows[0].id as string), token };
}
/** Fail closed on a missing/expired lease immediately before a send or publication. */
export async function requireClaim(id: string, token: string): Promise<void> {
  const rows = await sharedDb().execute(sql`select id from development_executions where id=${id} and claim_token=${token} and claim_until>now() and generation_status='running'`);
  if (!rows[0]) throw new DevelopmentError(409, 'claim_lost', 'Worker ownership expired; this request must not be resent.');
}
/** Persist the next replay request before yielding; a repeated ordinal must have the identical hash. */
export async function checkpointCall(execution: Execution, token: string, section: SectionAttempt, ordinal: number, identity: string, request: RawCompletionCall, route: FrozenRoute): Promise<ExecutionCall> {
  await requireClaim(execution.id, token);
  await sharedDb().execute(sql`insert into development_execution_calls(id,execution_id,section_id,ordinal,identity,request,route,status) values(${randomUUID()},${execution.id},${section.id},${ordinal},${identity},${JSON.stringify(request)}::jsonb,${JSON.stringify(route)}::jsonb,'queued') on conflict(section_id,ordinal) do nothing`);
  const rows = await sharedDb().execute(sql`select * from development_execution_calls where section_id=${section.id} and ordinal=${ordinal}`);
  const call = rows[0] as unknown as ExecutionCall;
  if (call.identity !== identity) throw new DevelopmentError(409, 'replay_mismatch', 'The frozen completion request changed. Start a new execution; saved requests cannot be resent.');
  return call;
}
/** CAS transition: at most one delivery may turn a queued request into a sending request. */
export async function beginCall(id: string, token: string, callId: string): Promise<boolean> {
  const rows = await sharedDb().execute(sql`update development_execution_calls set status='sending',sending_at=now() where id=${callId} and execution_id=${id} and status='queued' and exists(select 1 from development_executions where id=${id} and claim_token=${token} and claim_until>now() and generation_status='running') returning id`);
  return Boolean(rows[0]);
}
/** Settle a receipt before replay is allowed to expose its text; storage failure leaves sending intact. */
export async function settleCall(id: string, token: string, callId: string, receipt: CallReceipt | null, error: string | null = null, failure: ExecutionCall['failure_accounting'] = null): Promise<void> {
  const rows = await sharedDb().execute(sql`update development_execution_calls set status=${receipt ? 'succeeded' : 'failed'},settled_at=now(),receipt=${receipt ? JSON.stringify(receipt) : null}::jsonb,error=${error},failure_accounting=${failure ? JSON.stringify(failure) : null}::jsonb where id=${callId} and execution_id=${id} and status='sending' and exists(select 1 from development_executions where id=${id} and claim_token=${token} and claim_until>now()) returning id`);
  if (!rows[0]) throw new DevelopmentError(409, 'receipt_unsettled', 'A provider request may have completed but its receipt could not be settled. Inspect this execution before a fresh attempt.');
}
/** Publish one section atomically under its worker claim, retaining exact dependency IDs. */
export async function publishSection(id: string, token: string, sectionId: string, status: SectionStatus, result: DevelopmentSectionResult | null, error: string | null, prerequisites: SectionAttempt['prerequisites']): Promise<void> {
  const rows = await sharedDb().execute(sql`update development_execution_sections set status=${status},result=${result ? JSON.stringify(result) : null}::jsonb,error=${error},prerequisites=${JSON.stringify(prerequisites)}::jsonb where id=${sectionId} and execution_id=${id} and status in ('queued','running') and exists(select 1 from development_executions where id=${id} and claim_token=${token} and claim_until>now()) returning id`);
  if (!rows[0]) throw new DevelopmentError(409, 'claim_lost', 'Section publication lost worker ownership.');
}
/** Release a bounded invocation; indeterminate sends stop the execution permanently. */
export async function releaseExecution(id: string, token: string, status: GenerationStatus, error: string | null = null): Promise<void> {
  await sharedDb().transaction(async tx => {
    const rows = await tx.execute(sql`update development_executions set generation_status=${status},error=${error},claim_token=null,claim_until=null,updated_at=${new Date().toISOString()} where id=${id} and claim_token=${token} returning id`);
    if (!rows[0]) throw new DevelopmentError(409, 'claim_lost', 'Execution release lost worker ownership.');
    if (status === 'needs_attention') await tx.execute(sql`update development_execution_calls set status='needs_attention',error=coalesce(error,${error}) where execution_id=${id} and status='sending'`);
  });
}
