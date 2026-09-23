import { eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import type { MissFlagSuggested } from "@/accuracy/modules/completeness-audit/engine";
import { requireValidationRationale } from "./claim-store";

export type MissFlagAction = "dismiss" | "promote";

export type MissFlagActionRow = typeof t.accuracyMissFlagActions.$inferSelect;

const MISS_FLAG_DDL = `CREATE TABLE IF NOT EXISTS accuracy_miss_flag_actions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  block_id text NOT NULL,
  action text NOT NULL,
  suggested text,
  claim_id text,
  rationale text NOT NULL,
  actor_name text NOT NULL,
  actor_function text NOT NULL,
  created_at text NOT NULL
)`;

async function ensureMissFlagTable() {
  // Extra DDL so hot-reload / already-booted schema still gets the table.
  await ensureAccuracySchema([MISS_FLAG_DDL]);
}

export async function listMissFlagActions(workspace_id: string): Promise<MissFlagActionRow[]> {
  await ensureMissFlagTable();
  return accuracyDb()
    .select()
    .from(t.accuracyMissFlagActions)
    .where(eq(t.accuracyMissFlagActions.workspace_id, workspace_id));
}

/** Block ids already promoted or dismissed — excluded from the open miss-flag inbox. */
export async function resolvedMissFlagBlockIds(workspace_id: string): Promise<Set<string>> {
  const rows = await listMissFlagActions(workspace_id);
  return new Set(rows.map((row) => row.block_id));
}

export async function recordMissFlagAction(args: {
  workspace_id: string;
  block_id: string;
  action: MissFlagAction;
  suggested?: MissFlagSuggested | null;
  claim_id?: string | null;
  rationale: string;
  actor: Actor;
}): Promise<MissFlagActionRow> {
  await ensureMissFlagTable();
  const rationale = requireValidationRationale(args.rationale);
  const row = {
    id: newId("mfa"),
    workspace_id: args.workspace_id,
    block_id: args.block_id,
    action: args.action,
    suggested: args.suggested ?? null,
    claim_id: args.claim_id ?? null,
    rationale,
    actor_name: args.actor.name,
    actor_function: args.actor.function,
    created_at: nowIso(),
  };
  await accuracyDb().insert(t.accuracyMissFlagActions).values(row);
  return row as MissFlagActionRow;
}
