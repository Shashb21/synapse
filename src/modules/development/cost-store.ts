/** Transactional execution-scoped reservations and append-only owner spending decisions. */
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { DevelopmentError } from './schema';
import { canonicalParsedJson } from './documents';
import { costActionSchema, costControlsSchema, type CostAction, type CostControls } from './cost-schema';
import { estimateDevelopmentCost, type CostEstimate, type RawCallBound, type UsageCost } from './cost';
type Tx = Parameters<Parameters<ReturnType<typeof sharedDb>['transaction']>[0]>[0];
export type CostEvent = { id: string; action: string; actor: string; at: string; detail: Record<string, unknown> };
export type CostReservation = { call_id: string; kind: 'generation' | 'evaluation'; bound_usd: number | null; status: 'active' | 'settled'; usage_cost: UsageCost | null; bound_evidence: RawCallBound; created_at: string; settled_at: string | null };
export type CostAccountSummary = { execution_id: string; currency: 'USD'; allowance_usd: number; unknown_acknowledged: boolean; override_enabled: boolean; paused: boolean; pause_reason: string | null; estimate: CostEstimate; reserved_usd: number; generation_usage_usd: number | null; evaluation_usage_usd: number | null; unknown_usage_calls: number; unknown_active_reservations: number; reported_total: { amount: number; currency: string; note: string; actor: string; at: string } | null; events: CostEvent[]; reservations: CostReservation[] };
/** Expected budget refusal: keep replay-safe jobs queued, with no provider send. */
export class CostPause extends DevelopmentError { constructor(message: string) { super(409, 'cost_paused', message); } }
/** A saved provider outcome is replayable, but accounting must recover before publication. */
export class CostSettlementPending extends Error {
  constructor(cause: unknown) { super('Saved provider accounting could not be recorded; retry ledger settlement without resending.', { cause }); }
}
/** Install the additive schema through the same bootstrap used by execution workers. */
export async function ensureCostTables(): Promise<void> { await (await import('./execution-store')).ensureExecutionTables(); }
/** Initialize within execution publication; no controls means no spending authorization. */
export async function initializeCostAccount(tx: Tx, executionId: string, controls: CostControls | undefined, actor: string, estimate = estimateDevelopmentCost()): Promise<void> {
  const parsed = costControlsSchema.parse(controls ?? {});
  const paused = !controls || parsed.allowance_usd === 0;
  await tx.execute(sql`insert into development_cost_accounts(execution_id,allowance_usd,unknown_acknowledged,paused,pause_reason,estimate) values(${executionId},${parsed.allowance_usd},${parsed.unknown_acknowledged},${paused},${paused ? 'Set an allowance and explicitly resume before spending.' : null},${JSON.stringify(estimate)}::jsonb) on conflict(execution_id) do nothing`);
  await tx.execute(sql`insert into development_cost_events(execution_id,action,actor,detail) values(${executionId},'created',${actor},${JSON.stringify({ ...parsed, http_max_attempts: 1, uncertain_resend: false })}::jsonb)`);
}
/** Read a serializable account only after exact experiment ownership has been checked. */
export async function getCostAccount(experimentId: string, executionId: string): Promise<CostAccountSummary | null> {
  await ensureCostTables();
  const owned = await sharedDb().execute(sql`select id from development_executions where id=${executionId} and experiment_id=${experimentId}`);
  if (!owned[0]) throw new DevelopmentError(404, 'not_found', 'That execution does not belong to this experiment.');
  const rows = await sharedDb().execute(sql`select * from development_cost_accounts where execution_id=${executionId}`);
  if (!rows[0]) return null;
  const row = rows[0];
  const saved = await sharedDb().execute(sql`select * from development_cost_reservations where execution_id=${executionId} order by created_at,call_id`);
  const reservations = saved.map(r => ({ ...r, bound_usd: r.bound_usd === null ? null : Number(r.bound_usd), created_at: new Date(r.created_at as string).toISOString(), settled_at: r.settled_at ? new Date(r.settled_at as string).toISOString() : null })) as unknown as CostReservation[];
  const history = await sharedDb().execute(sql`select * from development_cost_events where execution_id=${executionId} order by id`);
  const events = history.map(e => ({ ...e, id: String(e.id), at: new Date(e.at as string).toISOString() })) as unknown as CostEvent[];
  const knownSubtotal = (kind: CostReservation['kind']): number | null => {
    const knownAmounts = reservations
      .filter(reservation => reservation.kind === kind)
      .flatMap(reservation => typeof reservation.usage_cost?.cost_usd === 'number' ? [reservation.usage_cost.cost_usd] : []);
    return knownAmounts.length ? knownAmounts.reduce((sum, amount) => sum + amount, 0) : null;
  };
  const activeReservations = reservations.filter(reservation => reservation.status === 'active');
  const reservedUsd = activeReservations.reduce((sum, reservation) => sum + (reservation.bound_usd ?? 0), 0);
  const unknownUsageCalls = reservations.filter(reservation => reservation.status === 'settled' && reservation.usage_cost?.cost_usd == null).length;
  const unknownActiveReservations = activeReservations.filter(reservation => reservation.bound_usd === null).length;
  const latestReport = events.filter(event => event.action === 'report').at(-1);
  // Report details were validated when appended; retain their original serialized shape.
  const reportedTotal = latestReport ? {
    ...latestReport.detail,
    actor: latestReport.actor,
    at: latestReport.at,
  } as CostAccountSummary['reported_total'] : null;
  return {
    execution_id: executionId,
    currency: 'USD',
    allowance_usd: Number(row.allowance_usd),
    unknown_acknowledged: Boolean(row.unknown_acknowledged),
    override_enabled: Boolean(row.override_enabled),
    paused: Boolean(row.paused),
    pause_reason: row.pause_reason as string | null,
    estimate: row.estimate as CostEstimate,
    reserved_usd: reservedUsd,
    generation_usage_usd: knownSubtotal('generation'),
    evaluation_usage_usd: knownSubtotal('evaluation'),
    unknown_usage_calls: unknownUsageCalls,
    unknown_active_reservations: unknownActiveReservations,
    reported_total: reportedTotal,
    events,
    reservations,
  };
}
/** Lock one account before every raw send; concurrent workers cannot oversubscribe known bounds. */
export async function reserveCost(executionId: string, callId: string, kind: CostReservation['kind'], bound: RawCallBound): Promise<void> {
  await ensureCostTables();
  if (bound.cost_usd !== null && (!Number.isFinite(bound.cost_usd) || bound.cost_usd < 0)) throw new DevelopmentError(400, 'invalid_bound', 'A reservation must have a finite nonnegative amount or explicit unknown.');
  const refusal = await sharedDb().transaction(async tx => {
    const rows = await tx.execute(sql`select * from development_cost_accounts where execution_id=${executionId} for update`);
    if (!rows[0]) return 'Historical execution has no spending authorization. Start a fresh controlled execution.';
    const account = rows[0];
    const duplicate = await tx.execute(sql`select * from development_cost_reservations where call_id=${callId}`);
    if (duplicate[0] && duplicate[0].execution_id === executionId && duplicate[0].kind === kind && duplicate[0].status === 'active' && canonicalParsedJson(duplicate[0].bound_evidence) === canonicalParsedJson(bound)) {
      const safe = kind === 'generation'
        ? await tx.execute(sql`select id from development_execution_calls where id=${callId} and execution_id=${executionId} and status='queued' and sending_at is null`)
        : await tx.execute(sql`select id from development_evaluations where id=${callId} and manifest->>'execution_id'=${executionId} and status='running' and sending_at is null`);
      if (safe[0]) return account.paused ? String(account.pause_reason ?? 'Spending is paused.') : null;
    }
    if (duplicate[0]) throw new DevelopmentError(409, 'reservation_conflict', 'This raw call already has a reservation and cannot be dispatched again.');
    const totals = await tx.execute(sql`select coalesce(sum(case when status='active' then greatest(coalesce(bound_usd,0),coalesce((usage_cost->>'cost_usd')::numeric,0)) else coalesce((usage_cost->>'cost_usd')::numeric,0) end),0) as committed from development_cost_reservations where execution_id=${executionId}`);
    const reason = account.paused ? String(account.pause_reason ?? 'Spending is paused.') : bound.cost_usd === null && !account.unknown_acknowledged ? 'Acknowledge unknown provider charges for this execution, then resume.' : !account.override_enabled && (Number(account.allowance_usd) <= 0 || Number(totals[0].committed) + (bound.cost_usd ?? 0) > Number(account.allowance_usd)) ? 'The next request exceeds the remaining USD allowance. Increase or override, then resume.' : null;
    if (reason) {
      await tx.execute(sql`update development_cost_accounts set paused=true,pause_reason=${reason} where execution_id=${executionId}`);
      await tx.execute(sql`insert into development_cost_events(execution_id,action,actor,detail) values(${executionId},'budget_pause','system:worker',${JSON.stringify({ reason, call_id: callId, kind })}::jsonb)`);
      return reason;
    }
    await tx.execute(sql`insert into development_cost_reservations(call_id,execution_id,kind,bound_usd,bound_evidence,status) values(${callId},${executionId},${kind},${bound.cost_usd},${JSON.stringify(bound)}::jsonb,'active')`);
    return null;
  });
  if (refusal) throw new CostPause(refusal);
}
/** Settle only with saved receipt evidence; uncertain sends retain their active reservation. */
export async function settleCost(executionId: string, callId: string, usage: UsageCost, settled = true): Promise<void> {
  await ensureCostTables();
  if (usage.cost_usd !== null && (!Number.isFinite(usage.cost_usd) || usage.cost_usd < 0)) {
    throw new DevelopmentError(400, 'invalid_usage_cost', 'Usage cost must be finite and nonnegative or explicitly unknown.');
  }
  await sharedDb().transaction(async tx => {
    await tx.execute(sql`select execution_id from development_cost_accounts where execution_id=${executionId} for update`);
    await tx.execute(sql`update development_cost_reservations set status=${settled ? 'settled' : 'active'},usage_cost=${JSON.stringify(usage)}::jsonb,settled_at=${settled ? new Date().toISOString() : null}::timestamptz where execution_id=${executionId} and call_id=${callId} and status='active'`);
  });
}
/** Audit owner actions; increasing/acknowledging never resumes implicitly or changes immutable manifests. */
export async function applyCostAction(experimentId: string, executionId: string, raw: CostAction, actor: string): Promise<CostAccountSummary> {
  const action = costActionSchema.parse(raw); await ensureCostTables();
  await (await import('./evaluation-store')).ensureEvaluationTables();
  if (!actor.trim()) throw new DevelopmentError(400, 'missing_actor', 'An authenticated actor is required.');
  await sharedDb().transaction(async tx => {
    const owned = await tx.execute(sql`select id from development_executions where id=${executionId} and experiment_id=${experimentId}`);
    if (!owned[0]) throw new DevelopmentError(404, 'not_found', 'That execution does not belong to this experiment.');
    const rows = await tx.execute(sql`select * from development_cost_accounts where execution_id=${executionId} for update`);
    if (!rows[0]) throw new DevelopmentError(409, 'historical_cost_unavailable', 'This historical execution has no cost account.');
    const account = rows[0];
    if (action.action === 'increase') {
      if (!Number.isFinite(Number(account.allowance_usd) + action.amount_usd)) throw new DevelopmentError(400, 'invalid_amount', 'The allowance is outside the supported numeric range.');
      await tx.execute(sql`update development_cost_accounts set allowance_usd=allowance_usd+${action.amount_usd} where execution_id=${executionId}`);
    }
    if (action.action === 'override') await tx.execute(sql`update development_cost_accounts set override_enabled=${action.enabled} where execution_id=${executionId}`);
    if (action.action === 'acknowledge_unknown') await tx.execute(sql`update development_cost_accounts set unknown_acknowledged=true where execution_id=${executionId}`);
    if (action.action === 'pause') await tx.execute(sql`update development_cost_accounts set paused=true,pause_reason='Paused by owner.' where execution_id=${executionId}`);
    if (action.action === 'resume') {
      if (!account.override_enabled && Number(account.allowance_usd) <= 0) throw new CostPause('Set a positive allowance or enable an override before resuming.');
      const uncertain = await tx.execute(sql`select id from development_execution_calls where execution_id=${executionId} and (status in ('sending','needs_attention') or (status='failed' and exists(select 1 from development_cost_reservations r where r.call_id=development_execution_calls.id and r.status='active'))) union all select id from development_evaluations where manifest->>'execution_id'=${executionId} and (status in ('sending','needs_attention') or (status='failed' and exists(select 1 from development_cost_reservations r where r.call_id=development_evaluations.id and r.status='active'))) limit 1`);
      if (uncertain[0]) throw new DevelopmentError(409, 'uncertain_call', 'Uncertain sends cannot be resumed. Inspect their provider acceptance first.');
      await tx.execute(sql`update development_cost_accounts set paused=false,pause_reason=null where execution_id=${executionId}`);
    }
    if (action.action === 'report') {
      const active = await tx.execute(sql`select id from development_executions where id=${executionId} and generation_status in ('queued','running') union all select id from development_evaluations where manifest->>'execution_id'=${executionId} and status in ('queued','running','sending','received') limit 1`);
      if (active[0]) throw new DevelopmentError(409, 'execution_active', 'Report execution spend after generation and evaluation finish.');
    }
    await tx.execute(sql`insert into development_cost_events(execution_id,action,actor,detail) values(${executionId},${action.action},${actor},${JSON.stringify(action)}::jsonb)`);
  });
  return (await getCostAccount(experimentId, executionId))!;
}
/** An explicitly funded evaluator start adds to the shared allowance; omitted controls never authorize new spending. */
export async function configureEvaluationCosts(experimentId: string, executionId: string, controls: CostControls | undefined, actor: string): Promise<void> {
  await ensureCostTables();
  await sharedDb().transaction(async tx => {
    const owned = await tx.execute(sql`select id from development_executions where id=${executionId} and experiment_id=${experimentId}`);
    if (!owned[0]) throw new DevelopmentError(404, 'not_found', 'That execution does not belong to this experiment.');
    const accounts = await tx.execute(sql`select * from development_cost_accounts where execution_id=${executionId} for update`);
    if (!accounts[0]) { await initializeCostAccount(tx, executionId, undefined, actor); }
    if (!controls) {
      await tx.execute(sql`update development_cost_accounts set paused=true,pause_reason='Evaluation start omitted spending controls; explicitly resume before spending.' where execution_id=${executionId}`);
      return;
    }
    const parsed = costControlsSchema.parse(controls);
    if (!Number.isFinite(Number(accounts[0]?.allowance_usd ?? 0) + parsed.allowance_usd)) {
      throw new DevelopmentError(400, 'invalid_amount', 'The allowance is outside the supported numeric range.');
    }
    // This is an explicit start authorization, not an allowance-action resume. Existing uncertain sends remain terminal.
    if (parsed.allowance_usd > 0) await tx.execute(sql`update development_cost_accounts set allowance_usd=allowance_usd+${parsed.allowance_usd},unknown_acknowledged=unknown_acknowledged or ${parsed.unknown_acknowledged} where execution_id=${executionId}`);
    else if (parsed.unknown_acknowledged) await tx.execute(sql`update development_cost_accounts set unknown_acknowledged=true where execution_id=${executionId}`);
    await tx.execute(sql`insert into development_cost_events(execution_id,action,actor,detail) values(${executionId},'evaluation_controls',${actor},${JSON.stringify(parsed)}::jsonb)`);
  });
}
