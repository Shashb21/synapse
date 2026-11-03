/** Real database proof that test cleanup preserves original rows, metadata and empty state. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { preservePersistedControls } from './support/persisted-controls';

let restoreOriginal: (() => Promise<void>) | undefined;
beforeEach(async () => {
  restoreOriginal = await preservePersistedControls(['accuracy_routing_config']);
  await sharedDb().execute(sql`delete from accuracy_routing_config`);
});
afterEach(async () => {
  try { await restoreOriginal?.(); }
  finally { restoreOriginal = undefined; }
});

it('restores original controls and metadata, removing rows inserted before a consumer fails', async () => {
  await sharedDb().execute(sql`insert into accuracy_routing_config
    (call_kind, agent_role, provider_id, model, params, fallbacks, updated_by, updated_at)
    values ('need_extract', 'proposer', 'openai', 'gpt-5.1', '{"temperature":0.17,"max_tokens":1234}', '["anthropic-claude"]', 'original owner', '2026-01-02T03:04:05Z')`);
  const restore = await preservePersistedControls(['accuracy_routing_config']);
  await expect((async () => {
    try {
      await sharedDb().execute(sql`update accuracy_routing_config set provider_id='xai-grok', updated_by='changed owner', updated_at='changed'`);
      await sharedDb().execute(sql`insert into accuracy_routing_config
        (call_kind, agent_role, provider_id, model, params, fallbacks, updated_by, updated_at)
        values ('inventory_extract', 'proposer', 'xai-grok', 'grok-4', '{}', '[]', 'new owner', 'new')`);
      throw new Error('Consumer failed after changing controls');
    } finally { await restore(); }
  })()).rejects.toThrow('Consumer failed after changing controls');
  expect(await sharedDb().execute(sql`select * from accuracy_routing_config`)).toEqual([{
    call_kind: 'need_extract', agent_role: 'proposer', provider_id: 'openai', model: 'gpt-5.1',
    params: { temperature: 0.17, max_tokens: 1234 }, fallbacks: ['anthropic-claude'],
    updated_by: 'original owner', updated_at: '2026-01-02T03:04:05Z',
  }]);
});

it('restores an originally empty control table without seeding default rows', async () => {
  const restore = await preservePersistedControls(['accuracy_routing_config']);
  await sharedDb().execute(sql`insert into accuracy_routing_config
    (call_kind, agent_role, provider_id, model, params, fallbacks, updated_by, updated_at)
    values ('need_extract', 'proposer', 'xai-grok', 'grok-4', '{}', '[]', 'new owner', 'new')`);
  await restore();
  expect(await sharedDb().execute(sql`select * from accuracy_routing_config`)).toEqual([]);
});
