/** Owner spending inputs remain separate from immutable generation/evaluator configuration. */
import { z } from 'zod';
const amount = z.number().finite().nonnegative();
const currencies = new Set(Intl.supportedValuesOf('currency'));
export const costControlsSchema = z.object({ allowance_usd: amount.default(0), unknown_acknowledged: z.boolean().default(false) }).strict();
export type CostControls = z.infer<typeof costControlsSchema>;
export const costActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('increase'), amount_usd: amount.refine(n => n > 0) }).strict(),
  z.object({ action: z.literal('override'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('acknowledge_unknown') }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('report'), amount, currency: z.string().refine(value => currencies.has(value)), note: z.string().trim().max(2000).default('') }).strict(),
]);
export type CostAction = z.infer<typeof costActionSchema>;
/** Additive ledger storage; account updates serialize all generation and evaluation spending. */
export const COST_DDL = [
  `create table if not exists development_cost_accounts (execution_id text primary key references development_executions(id), allowance_usd numeric not null check(allowance_usd>=0), unknown_acknowledged boolean not null default false, override_enabled boolean not null default false, paused boolean not null default true, pause_reason text, estimate jsonb not null, created_at timestamptz not null default now())`,
  `create table if not exists development_cost_reservations (call_id text primary key, execution_id text not null references development_cost_accounts(execution_id), kind text not null check(kind in ('generation','evaluation')), bound_usd numeric check(bound_usd>=0), bound_evidence jsonb not null, status text not null check(status in ('active','settled')), usage_cost jsonb, created_at timestamptz not null default now(), settled_at timestamptz)`,
  `create table if not exists development_cost_events (id bigserial primary key, execution_id text not null references development_cost_accounts(execution_id), action text not null, actor text not null, detail jsonb not null, at timestamptz not null default now())`,
  `create or replace function development_cost_history_immutable() returns trigger language plpgsql as $$ begin raise exception 'cost history is append only'; end $$`,
  `do $$ begin if not exists(select 1 from pg_trigger where tgname='development_cost_events_immutable') then create trigger development_cost_events_immutable before update or delete on development_cost_events for each row execute function development_cost_history_immutable(); end if; end $$`,
];
