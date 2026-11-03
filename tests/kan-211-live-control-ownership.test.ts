/**
 * KAN-211 characterization: Arrange prepares persisted live/legacy records;
 * Act saves through the real owner API and resolves the customer run route;
 * Assert checks scripted provider sends, isolation and durable audit history.
 * All provider HTTP is blocked; only provider adapters return scripted JSON.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('@/lib/demo/mode', () => ({ replaysDemo: async () => false }));
import { sql } from 'drizzle-orm';
import { preservePersistedControls } from './support/persisted-controls';
import { sharedDb } from '@/lib/iegp/db';
import { POST } from '@/app/api/control/route';
import { routeConfig, setRouteConfig, completionFor } from '@/modules/kernel/routing';
import { resolveRouteForRun } from '@/modules/kernel/run';
import { setAccuracyRouteConfig } from '@/accuracy/kernel/routing';
import { getAuditEvent, listAuditEvents } from '@/modules/kernel/audit';
import { RunRecorder } from '@/modules/kernel/observability';
import { xaiGrok, findProvider } from '@/modules/llm/provider';
import * as llm from '@/modules/kernel/llm';
import * as owner from '@/modules/auth/owner';
import { sessionContext } from '@/modules/auth/session';

let restoreControls: (() => Promise<void>) | undefined;
const actor = 'KAN-211 ownership proof';
const control = (patch: Record<string, unknown> = {}) => POST(new Request('http://localhost/api/control', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'set_route', stage: 'S2', provider_id: 'xai-grok', model: 'grok-4', temperature: 0.42, max_tokens: 4321, fallbacks: [], actor_name: actor, actor_function: 'medical_affairs', ...patch }),
}));

beforeEach(async () => {
  restoreControls = await preservePersistedControls();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unscripted network is forbidden in KAN-211.'));
  vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
  vi.stubEnv('XAI_API_KEY', 'test-only-never-send');
  vi.stubEnv('OPENAI_API_KEY', 'test-only-never-send');
  await setRouteConfig({ stage: 'S2', provider_id: 'openai', model: 'gpt-5.1', temperature: 0.1, max_tokens: 2222, fallbacks: [], actor_name: 'prior live owner' });
  await setRouteConfig({ stage: 'S3', provider_id: 'openai', model: 'gpt-5.1', temperature: 0.2, max_tokens: 3333, fallbacks: [], actor_name: 'unrelated live owner' });
  await setAccuracyRouteConfig({ call_kind: 'need_extract', agent_role: 'proposer', provider_id: 'openai', model: 'gpt-5.1', temperature: 1.2, max_tokens: 999, actor_name: 'legacy experiment owner' });
});
afterEach(async () => {
  try { await restoreControls?.(); }
  finally { restoreControls = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('saves only the intended live stage and sends its persisted values despite a conflicting Accuracy route, with attributed before/after audit', async () => {
  const auditIdentity = await sessionContext();
  // Read IDs without pagination: inserting a row must not evict retention evidence.
  const auditIds = async () => (await sharedDb().execute(sql`select id from audit_events where action = 'set_route' and entity_id = 'S2'`)).map(row => String(row.id));
  const existingIds = await auditIds();
  expect((await control({ provider_id: 'openai', model: 'gpt-5.1', temperature: 0.1, max_tokens: 2222 })).status).toBe(200);
  const priorIds = await auditIds();
  const seededIds = priorIds.filter(id => !existingIds.includes(id));
  expect(seededIds).toHaveLength(1);
  const priorAudit = await getAuditEvent(seededIds[0]);
  expect(priorAudit).not.toBeNull();
  const before = await routeConfig('S2');
  const routes = await sharedDb().execute(sql`select * from routing_config where stage <> 'S2' order by stage`);
  const accuracy = await sharedDb().execute(sql`select * from accuracy_routing_config order by call_kind, agent_role`);
  const response = await control();
  expect(response.status).toBe(200);
  const saved = await routeConfig('S2');
  expect(saved).toMatchObject({ provider_id: 'xai-grok', model: 'grok-4', params: { temperature: 0.42, max_tokens: 4321 }, fallbacks: [], updated_by: actor });
  const route = await resolveRouteForRun('S2');
  expect(route.provider_id).toBe('xai-grok');
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue('{"ok":true}');
  const other = vi.spyOn(findProvider('openai')!, 'complete').mockRejectedValue(new Error('Conflicting Accuracy provider must not send.'));
  const result = await completionFor(route, new RunRecorder({ workspace_id: 'default', stage: 'S2', module_id: 'kan211-test', module_version: '1', actor: { name: actor, function: 'medical_affairs' }, input: {} }))({ system: 'scripted', user: 'scripted', purpose: 'kan211' });
  expect(result).toEqual({ ok: true });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toMatchObject({ model: 'grok-4', temperature: 0.42, max_tokens: 4321 });
  expect(other).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(await sharedDb().execute(sql`select * from routing_config where stage <> 'S2' order by stage`)).toEqual(routes);
  expect(await sharedDb().execute(sql`select * from accuracy_routing_config order by call_kind, agent_role`)).toEqual(accuracy);
  const addedIds = (await auditIds()).filter(id => !priorIds.includes(id));
  expect(addedIds).toHaveLength(1);
  const event = await getAuditEvent(addedIds[0]);
  expect(event).toMatchObject({ category: 'config', action: 'set_route', entity_id: 'S2', actor_name: auditIdentity.actor.name, actor_principal: auditIdentity.demo ? 'demo' : 'anonymous', workspace_id: null, before: { provider_id: before.provider_id, model: before.model, params: before.params, fallbacks: before.fallbacks }, after: { provider_id: saved.provider_id, model: saved.model, params: saved.params, fallbacks: saved.fallbacks } });
  // Audit attribution comes from request/session context, never a caller-supplied body name.
  expect(event?.actor_name).not.toBe(actor);
  expect(await getAuditEvent(seededIds[0])).toEqual(priorAudit);
});

it.each([
  { temperature: -1 }, { max_tokens: 1.5 }, { fallbacks: ['missing'] },
  { fallbacks: ['xai-grok'] }, { provider_id: 'missing' }, { model: 'missing' },
])('rejects invalid live edits without changing either routing store: %j', async patch => {
  const before = await sharedDb().execute(sql`select * from routing_config order by stage`);
  const accuracy = await sharedDb().execute(sql`select * from accuracy_routing_config order by call_kind, agent_role`);
  expect((await control(patch)).status).toBe(400);
  expect(await sharedDb().execute(sql`select * from routing_config order by stage`)).toEqual(before);
  expect(await sharedDb().execute(sql`select * from accuracy_routing_config order by call_kind, agent_role`)).toEqual(accuracy);
});

it('fails closed for unavailable credentials, and only uses an explicitly saved backup without changing saved configuration', async () => {
  expect((await control()).status).toBe(200);
  vi.stubEnv('XAI_API_KEY', '');
  const before = await routeConfig('S2');
  await expect(resolveRouteForRun('S2')).rejects.toThrow('XAI_API_KEY');
  expect(await routeConfig('S2')).toEqual(before);
  expect((await control({ fallbacks: ['openai'] })).status).toBe(200);
  const backedUp = await routeConfig('S2');
  expect(await resolveRouteForRun('S2')).toMatchObject({ provider_id: 'openai', degraded: true });
  expect(await routeConfig('S2')).toEqual(backedUp);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('rejects a non-owner edit before any saved route or audit changes', async () => {
  const before = await sharedDb().execute(sql`select * from routing_config order by stage`);
  const audits = (await listAuditEvents({ action: 'set_route', entity_id: 'S2' }, { limit: 100 })).events;
  vi.spyOn(owner, 'ownerAccess').mockResolvedValue({ owner: false } as Awaited<ReturnType<typeof owner.ownerAccess>>);
  expect((await control()).status).toBe(403);
  expect(await sharedDb().execute(sql`select * from routing_config order by stage`)).toEqual(before);
  expect((await listAuditEvents({ action: 'set_route', entity_id: 'S2' }, { limit: 100 })).events).toEqual(audits);
});
