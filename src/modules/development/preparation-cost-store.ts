/** Durable, per-upload authorization before any paid S1 preparation request. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import type { RawCallBound, UsageCost } from './cost';
import { DevelopmentError, type Experiment, type PreparationControls } from './schema';

let ready: Promise<void> | undefined;
async function ensurePreparationTables() {
  ready ??= sharedDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('development-preparation-spend-schema'))`);
    await tx.execute(sql`create table if not exists development_preparations (
      id uuid primary key, experiment_id text not null references development_experiments(id),
      revision integer not null, actor text not null, kind text not null check(kind in ('source','pdf_reference')),
      allowance_usd numeric not null check(allowance_usd >= 0), created_at timestamptz not null default now()
    )`);
    await tx.execute(sql`create table if not exists development_preparation_calls (
      id uuid primary key, preparation_id uuid not null references development_preparations(id),
      bound_usd numeric not null check(bound_usd >= 0), bound_evidence jsonb not null, usage_cost jsonb,
      sending_at timestamptz not null default now(), settled_at timestamptz
    )`);
    await tx.execute(sql`create index if not exists development_preparation_calls_upload on development_preparation_calls(preparation_id)`);
  }).catch(error => { ready = undefined; throw error; });
  await ready;
}

/** A repeated upload ID represents the original authorization and never starts another send. */
export async function openPreparationAllowance(
  experiment: Experiment, actor: string, kind: 'source' | 'pdf_reference', controls?: PreparationControls,
): Promise<string> {
  await ensurePreparationTables();
  const id = controls?.id ?? randomUUID();
  await sharedDb().transaction(async tx => {
    const [draft] = await tx.execute(sql`select revision from development_experiments where id=${experiment.id} for share`);
    if (!draft || Number(draft.revision) !== experiment.revision) {
      throw new DevelopmentError(409, 'stale_revision', 'The draft changed. Reload it before preparing this file.');
    }
    const [created] = await tx.execute(sql`insert into development_preparations(id,experiment_id,revision,actor,kind,allowance_usd)
      values(${id}::uuid,${experiment.id},${experiment.revision},${actor},${kind},${String(controls?.allowance_usd ?? 0)}::numeric)
      on conflict(id) do nothing returning id`);
    if (!created) throw new DevelopmentError(409, 'preparation_already_started', 'This upload authorization was already used. Review the saved draft and provider usage before authorizing a new paid attempt.');
  });
  return id;
}

/** The reservation and sending marker commit together for each physical request. */
export async function beginPreparationCall(preparationId: string, bound: RawCallBound): Promise<string> {
  const amount = bound.cost_usd;
  if (amount === null || !Number.isFinite(amount) || amount < 0) {
    throw new DevelopmentError(409, 'unverified_preparation_cost', 'The configured S1 parsing route has no verified spending limit. Choose a supported priced or free S1 route in AI & routing.');
  }
  const callId = randomUUID();
  await sharedDb().transaction(async tx => {
    const [account] = await tx.execute(sql`select id from development_preparations where id=${preparationId}::uuid for update`);
    if (!account) throw new DevelopmentError(409, 'preparation_not_authorized', 'Authorize this upload before model preparation.');
    const [draft] = await tx.execute(sql`select d.revision = p.revision as current
      from development_experiments d join development_preparations p on p.experiment_id=d.id where p.id=${preparationId}::uuid for share of d`);
    if (!draft?.current) throw new DevelopmentError(409, 'stale_revision', 'The draft changed. Reload it before preparing this file.');
    const [budget] = await tx.execute(sql`
      select allowance_usd >= ${String(amount)}::numeric + coalesce((
        select sum(coalesce((usage_cost->>'cost_usd')::numeric,bound_usd))
        from development_preparation_calls where preparation_id=${preparationId}::uuid
      ),0) as affordable from development_preparations where id=${preparationId}::uuid`);
    if (amount > 0 && !budget?.affordable) {
      throw new DevelopmentError(409, 'preparation_allowance_exceeded', `The next preparation request needs a USD ${amount} reservation. Review the upload allowance before making a new attempt.`);
    }
    await tx.execute(sql`insert into development_preparation_calls(id,preparation_id,bound_usd,bound_evidence)
      values(${callId}::uuid,${preparationId}::uuid,${String(amount)}::numeric,${JSON.stringify(bound)}::jsonb)`);
  });
  return callId;
}

export async function settlePreparationCall(preparationId: string, callId: string, usage: UsageCost): Promise<void> {
  await sharedDb().transaction(async tx => {
    await tx.execute(sql`select id from development_preparations where id=${preparationId}::uuid for update`);
    await tx.execute(sql`update development_preparation_calls set usage_cost=${JSON.stringify(usage)}::jsonb,settled_at=now()
      where preparation_id=${preparationId}::uuid and id=${callId}::uuid and settled_at is null`);
  });
}
