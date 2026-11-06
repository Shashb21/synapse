/** Snapshot persisted controls so serial database tests restore values and metadata after failures. */
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { ensurePlatformSchema } from '@/modules/kernel/db';
import { PLATFORM_SETTINGS_DDL } from '@/modules/kernel/ai-switch';

type ControlTable = 'routing_config' | 'accuracy_routing_config' | 'platform_settings' | 'stage_modules';

/**
 * Capture existing rows, returning an atomic restore operation for afterEach.
 * Only use with serial tests against a disposable database: restoring a whole
 * table would overwrite another concurrent writer's controls.
 */
export async function preservePersistedControls(
  tables: readonly ControlTable[] = ['routing_config', 'accuracy_routing_config', 'platform_settings', 'stage_modules'],
): Promise<() => Promise<void>> {
  await ensurePlatformSchema();
  // Historical table exists only in this disposable test database; production data is untouched.
  await sharedDb().execute(sql.raw(`CREATE TABLE IF NOT EXISTS accuracy_routing_config (
    call_kind text NOT NULL, agent_role text NOT NULL, provider_id text NOT NULL,
    model text NOT NULL, params jsonb NOT NULL, fallbacks jsonb NOT NULL,
    updated_by text NOT NULL, updated_at text NOT NULL, UNIQUE (call_kind, agent_role)
  )`));
  await sharedDb().execute(sql.raw(PLATFORM_SETTINGS_DDL));
  const snapshots: { table: ControlTable; rows: string }[] = [];
  for (const table of tables) {
    const rows = await sharedDb().execute(sql`select * from ${sql.identifier(table)}`);
    snapshots.push({ table, rows: JSON.stringify(rows) });
  }
  return async () => {
    await sharedDb().transaction(async tx => {
      for (const { table, rows } of snapshots) {
        await tx.execute(sql`delete from ${sql.identifier(table)}`);
        await tx.execute(sql`insert into ${sql.identifier(table)} select * from json_populate_recordset(null::${sql.identifier(table)}, ${rows}::json)`);
      }
    });
  };
}

/** Seed a historical route to prove current execution leaves legacy records alone. */
export async function seedHistoricalRoute(temperature: number, actor: string): Promise<void> {
  await sharedDb().execute(sql`insert into accuracy_routing_config
    (call_kind, agent_role, provider_id, model, params, fallbacks, updated_by, updated_at)
    values ('need_extract', 'proposer', 'openai', 'gpt-5.1', ${JSON.stringify({ temperature, max_tokens: 999 })}::jsonb, '[]'::jsonb, ${actor}, '2026-11-03T00:00:00.000Z')
    on conflict (call_kind, agent_role) do update set provider_id = excluded.provider_id, model = excluded.model,
      params = excluded.params, fallbacks = excluded.fallbacks, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
}
