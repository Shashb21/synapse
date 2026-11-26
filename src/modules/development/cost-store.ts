/** Transactional execution-scoped reservations and append-only owner spending decisions. */
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { DevelopmentError } from './schema';
import { costActionSchema, costControlsSchema, type CostAction, type CostControls } from './cost-schema';
import { estimateDevelopmentCost, type CostEstimate, type RawCallBound, type UsageCost } from './cost';
type Tx = Parameters<Parameters<ReturnType<typeof sharedDb>['transaction']>[0]>[0];
const PRICING_METHOD = 'documented_provider_rate';
export type CostEvent = { id: string; action: string; actor: string; at: string; detail: Record<string, unknown> };
export type CostReservation = { call_id: string; kind: 'generation' | 'evaluation'; bound_usd: number | null; status: 'active' | 'settled'; usage_cost: (UsageCost & { pricing_method?: typeof PRICING_METHOD }) | null; bound_evidence: RawCallBound; created_at: string; settled_at: string | null };
export type CostAccountSummary = { execution_id: string; currency: 'USD'; allowance_usd: number; unknown_acknowledged: boolean; override_enabled: boolean; paused: boolean; pause_reason: string | null; estimate: CostEstimate; reserved_usd: number; generation_usage_usd: number | null; evaluation_usage_usd: number | null; unknown_usage_calls: number; unknown_active_reservations: number; reported_total: { amount: number; currency: string; note: string; actor: string; at: string } | null; events: CostEvent[]; reservations: CostReservation[] };
/** Expected budget refusal: keep replay-safe jobs queued, with no provider send. */
export class CostPause extends DevelopmentError { constructor(message: string) { super(409, 'cost_paused', message); } }
/** The immutable route cannot be funded using the verified rates and caps. */
export class CostUnverified extends DevelopmentError {
  constructor(message: string) { super(409, 'unverified_route_cost', message); }
}
/** A saved provider outcome is replayable, but accounting must recover before publication. */
export class CostSettlementPending extends Error {
  constructor(cause: unknown) { super('Saved provider accounting could not be recorded; retry ledger settlement without resending.', { cause }); }
}
/** Install the additive schema through the same bootstrap used by execution workers. */
export async function ensureCostTables(): Promise<void> { await (await import('./execution-store')).ensureExecutionTables(); }
/** Initialize within execution publication; no controls means no spending authorization. */
export async function initializeCostAccount(tx: Tx, executionId: string, controls: CostControls | undefined, actor: string, estimate = estimateDevelopmentCost()): Promise<void> {
  const parsed = costControlsSchema.parse(controls ?? {});
  const paused = !controls;
  await tx.execute(sql`insert into development_cost_accounts(execution_id,allowance_usd,unknown_acknowledged,paused,pause_reason,estimate) values(${executionId},${parsed.allowance_usd},${parsed.unknown_acknowledged},${paused},${paused ? 'Spending controls were omitted. Review the allowance and explicitly resume spending.' : null},${JSON.stringify(estimate)}::jsonb) on conflict(execution_id) do nothing`);
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
  const reservedUsd = reservations.reduce((sum, reservation) =>
    reservation.status === 'active' || reservation.usage_cost?.cost_usd == null ? sum + (reservation.bound_usd ?? 0) : sum, 0);
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
/** Lock the shared account before adding any new paid commitment. */
export async function reserveCost(executionId: string, callId: string, kind: CostReservation['kind'], bound: RawCallBound): Promise<void> {
  await ensureCostTables();
  const amount = bound.cost_usd;
  if (amount === null) throw new CostUnverified(bound.reason ?? 'The next request has no verified spending limit.');
  if (!Number.isFinite(amount) || amount < 0) {
    throw new DevelopmentError(400, 'invalid_bound', 'A spending bound must be finite and nonnegative.');
  }
  const refusal = await sharedDb().transaction(async tx => {
    const [account] = await tx.execute(sql`select paused,pause_reason from development_cost_accounts where execution_id=${executionId} for update`);
    if (!account) return 'Historical execution has no spending authorization. Start a fresh controlled execution.';
    const [duplicate] = await tx.execute(sql`select *, bound_usd >= ${String(amount)}::numeric as sufficient from development_cost_reservations where call_id=${callId}`);
    if (duplicate) {
      const sameCall = duplicate.execution_id === executionId && duplicate.kind === kind && duplicate.status === 'active' && duplicate.usage_cost === null;
      const unsent = sameCall && (kind === 'generation'
        ? await tx.execute(sql`select id from development_execution_calls where id=${callId} and execution_id=${executionId} and status='queued' and sending_at is null`)
        : await tx.execute(sql`select id from development_evaluations where id=${callId} and manifest->>'execution_id'=${executionId} and status='running' and sending_at is null`));
      if (!unsent || !unsent[0]) {
        throw new DevelopmentError(409, 'reservation_conflict', 'This reservation belongs to a different call or a dispatch record already exists.');
      }
      if (duplicate.sufficient) return account.paused ? String(account.pause_reason ?? 'Spending is paused.') : null;
    }
    if (account.paused) return String(account.pause_reason ?? 'Spending is paused.');

    let reason: string | null = null;
    if (amount > 0) {
      // Stay in PostgreSQL numeric arithmetic. A null legacy bound has no amount
      // we can safely subtract until the outcome or an unsent retry is verified.
      const [budget] = await tx.execute(sql`
        with charges as (
          select status, bound_usd, (usage_cost->>'cost_usd')::numeric as actual,
            coalesce(usage_cost->>'pricing_method' = ${PRICING_METHOD}, false) as priced
          from development_cost_reservations
          where execution_id=${executionId} and call_id<>${callId}
        ), totals as (
          select coalesce(sum(case
            when status='active' then greatest(bound_usd, actual)
            else coalesce(actual, bound_usd)
          end), 0) as committed,
          coalesce(bool_or(bound_usd is null and (status='active' or actual is null or not priced)), false) as unbounded
          from charges
        )
        select unbounded, committed + ${String(amount)}::numeric <= allowance_usd as affordable
        from totals cross join development_cost_accounts where execution_id=${executionId}
      `);
      if (budget.unbounded) throw new CostUnverified('An earlier request has an unresolved charge and no verified reservation. Start a fresh controlled execution for further paid requests.');
      if (!budget.affordable) reason = `The next request requires a USD ${amount} reservation and exceeds the remaining allowance. Increase the allowance, then resume.`;
    }
    if (reason) {
      await tx.execute(sql`update development_cost_accounts set paused=true,pause_reason=${reason} where execution_id=${executionId}`);
      await tx.execute(sql`insert into development_cost_events(execution_id,action,actor,detail) values(${executionId},'budget_pause','system:worker',${JSON.stringify({ reason, call_id: callId, kind })}::jsonb)`);
      return reason;
    }
    const dollars = String(amount);
    const evidence = JSON.stringify(bound);
    if (duplicate) {
      // Increase only the verified same queued checkpoint. Preserve any sufficient hold above.
      await tx.execute(sql`update development_cost_reservations set bound_usd=${dollars}::numeric,bound_evidence=${evidence}::jsonb where call_id=${callId}`);
    } else {
      await tx.execute(sql`insert into development_cost_reservations(call_id,execution_id,kind,bound_usd,bound_evidence,status) values(${callId},${executionId},${kind},${dollars}::numeric,${evidence}::jsonb,'active')`);
    }
    return null;
  });
  if (refusal) throw new CostPause(refusal);
}

const OWNER_PAUSE = 'Paused by owner.';
const OMITTED_EVALUATION_CONTROLS = 'Evaluation start omitted spending controls. Explicitly resume spending.';

/** Fence the sending marker against legacy null reservations and a concurrent owner pause. */
export async function requireCostDispatch(tx: Tx, executionId: string, callId: string, kind: CostReservation['kind']): Promise<void> {
  const [account] = await tx.execute(sql`select paused,pause_reason from development_cost_accounts where execution_id=${executionId} for update`);
  if (account?.paused && [OWNER_PAUSE, OMITTED_EVALUATION_CONTROLS].includes(String(account.pause_reason))) {
    throw new CostPause(String(account.pause_reason));
  }
  // A budget pause caused by a different request leaves existing funded sends authorized.
  const [funded] = await tx.execute(sql`select call_id from development_cost_reservations
    where execution_id=${executionId} and call_id=${callId} and kind=${kind} and status='active'
    and bound_usd >= 0 and bound_usd < 'Infinity'::numeric
    and usage_cost is null`);
  if (!funded) throw new CostPause('A verified reservation is required before dispatch.');
}

/** Settle only with saved receipt evidence; uncertain sends retain their active reservation. */
export async function settleCost(executionId: string, callId: string, usage: UsageCost, settled = true): Promise<void> {
  await ensureCostTables();
  if (usage.cost_usd !== null && (!Number.isFinite(usage.cost_usd) || usage.cost_usd < 0)) {
    throw new DevelopmentError(400, 'invalid_usage_cost', 'Usage cost must be finite and nonnegative or explicitly unknown.');
  }
  const priced = usage.cost_usd !== null && (usage.price !== null || Boolean(usage.price_source));
  const evidence = priced ? { ...usage, pricing_method: PRICING_METHOD } : usage;
  await sharedDb().transaction(async tx => {
    await tx.execute(sql`select execution_id from development_cost_accounts where execution_id=${executionId} for update`);
    await tx.execute(sql`update development_cost_reservations set status=${settled ? 'settled' : 'active'},usage_cost=${JSON.stringify(evidence)}::jsonb,settled_at=${settled ? new Date().toISOString() : null}::timestamptz where execution_id=${executionId} and call_id=${callId} and (
      (status='active' and (${usage.cost_usd !== null} or usage_cost->>'cost_usd' is null))
      or (status='settled' and ${settled} and ${priced} and (
        usage_cost->>'cost_usd' is null or (bound_usd is null and usage_cost->>'pricing_method' is distinct from ${PRICING_METHOD})
      ))
    )`);
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
    if (action.action === 'pause') await tx.execute(sql`update development_cost_accounts set paused=true,pause_reason=${OWNER_PAUSE} where execution_id=${executionId}`);
    if (action.action === 'resume') {
      const uncertain = await tx.execute(sql`select id from development_execution_calls where execution_id=${executionId} and (status in ('sending','needs_attention') or (status='failed' and exists(select 1 from development_cost_reservations r where r.call_id=development_execution_calls.id and r.status='active'))) union all select id from development_evaluations where manifest->>'execution_id'=${executionId} and (status in ('sending','needs_attention') or (status='failed' and exists(select 1 from development_cost_reservations r where r.call_id=development_evaluations.id and r.status='active'))) limit 1`);
      if (uncertain[0]) throw new DevelopmentError(409, 'uncertain_call', 'Uncertain sends cannot be resumed. Inspect their provider acceptance first.');
      await tx.execute(sql`update development_cost_accounts set paused=false,pause_reason=null where execution_id=${executionId}`);
    }
    if (action.action === 'report') {
      const active = await tx.execute(sql`select id from development_executions where id=${executionId} and generation_status in ('queued','running') union all select id from development_evaluations where manifest->>'execution_id'=${executionId} and status in ('queued','running','sending','received') limit 1`);
      if (active[0]) throw new DevelopmentError(409, 'execution_active', 'Report execution spend after generation and evaluation finish.');
    }
    const detail = action.action === 'override' || action.action === 'acknowledge_unknown'
      ? { ...action, effect: 'Recorded for review. A verified finite reservation remains required.' }
      : action;
    await tx.execute(sql`insert into development_cost_events(execution_id,action,actor,detail) values(${executionId},${action.action},${actor},${JSON.stringify(detail)}::jsonb)`);
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
      await tx.execute(sql`update development_cost_accounts set paused=true,pause_reason=${OMITTED_EVALUATION_CONTROLS} where execution_id=${executionId}`);
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
