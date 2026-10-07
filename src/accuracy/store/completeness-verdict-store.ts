import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { nowIso } from "@/modules/kernel/ids";

export type CompletenessVerdictRow = typeof t.accuracyCompletenessVerdicts.$inferSelect;

const VERDICT_DDL = `CREATE TABLE IF NOT EXISTS accuracy_completeness_verdicts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  block_id text NOT NULL,
  text_hash text NOT NULL,
  ledger_digest text NOT NULL,
  missed boolean NOT NULL,
  claim_type text,
  rationale text NOT NULL,
  run_id text NOT NULL,
  judged_at text NOT NULL
)`;

async function ensureVerdictTable() {
  // Extra DDL so hot-reload / already-booted schema still gets the table.
  await ensureAccuracySchema([VERDICT_DDL]);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verdictId(workspace_id: string, block_id: string, text_hash: string): string {
  return `${workspace_id}::${block_id}::${text_hash}`;
}

export async function listCompletenessVerdicts(
  workspace_id: string,
): Promise<CompletenessVerdictRow[]> {
  await ensureVerdictTable();
  return accuracyDb()
    .select()
    .from(t.accuracyCompletenessVerdicts)
    .where(eq(t.accuracyCompletenessVerdicts.workspace_id, workspace_id));
}

export async function saveCompletenessVerdicts(
  rows: Omit<CompletenessVerdictRow, "id" | "judged_at">[],
): Promise<void> {
  if (rows.length === 0) return;
  await ensureVerdictTable();
  const judged_at = nowIso();
  for (const row of rows) {
    const values = { ...row, id: verdictId(row.workspace_id, row.block_id, row.text_hash), judged_at };
    await accuracyDb()
      .insert(t.accuracyCompletenessVerdicts)
      .values(values)
      .onConflictDoUpdate({ target: t.accuracyCompletenessVerdicts.id, set: values });
  }
}
