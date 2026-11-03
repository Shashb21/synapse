/** Snapshot persisted controls so serial database tests restore values and metadata after failures. */
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { ensurePlatformSchema } from '@/modules/kernel/db';
import { ensureAccuracySchema } from '@/accuracy/store/db';
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
  await ensureAccuracySchema();
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
