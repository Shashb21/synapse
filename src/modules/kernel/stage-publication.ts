/** Workspace-local version fences for model work performed outside the database. */
import { sql } from "drizzle-orm";
import { db, withWorkspaceTransaction } from "@/lib/iegp/db";
import { ApiGuardError } from "@/modules/auth/api-guard";
import type { ModuleContext, StageId } from "./contracts";

const evidence = ["gaps", "sources", "source_blocks", "needs", "need_gap_links", "objectives"];
const mappings = [...evidence, "assets", "tactics", "tactic_expansions", "coverages", "mapping_suggestions"];
const inputTables: Partial<Record<StageId, readonly string[]>> = {
  S1: ["source_files", "parsed_documents", "sources", "source_blocks", "needs"],
  S2: [...evidence, "parsed_documents", "priority_placements", "gap_suggestions", "gap_candidates"],
  S3: ["sources", "source_blocks", "parsed_documents", "tactics", "tactic_suggestions", "tactic_expansions", "tactic_candidates"],
  S4: [...mappings, "mapping_candidates"],
  S9: [...mappings, "ideation_proposals", "priority_placements"],
};

/** Stages that compute proposals before their short workspace publication. */
export function usesStagePublication(stage: StageId): boolean {
  return inputTables[stage] !== undefined;
}

/** PostgreSQL gives every inserted or updated tuple a new version, including legacy editor writes. */
export async function stageInputVersion(stage: StageId, lock = false): Promise<string | undefined> {
  const tables = inputTables[stage];
  if (!tables) return undefined;
  if (lock) {
    // Include inserts and deletes, which a row lock alone would miss. NOWAIT
    // lets an editor already holding a conflicting lock finish first.
    try {
      await db().execute(sql`lock table ${sql.join(tables.map(name => sql.identifier(name)), sql`, `)} in exclusive mode nowait`);
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if ((e.cause?.code ?? e.code) === "55P03") throw staleStage();
      throw error;
    }
  }
  const versions = tables.map(table => sql`select ${table}::text as name,
    md5(coalesce(string_agg(ctid::text || ':' || xmin::text, ',' order by ctid), '')) as version
    from ${sql.identifier(table)}`);
  const rows = await db().execute(sql`select name, version from (${sql.join(versions, sql` union all `)}) versions order by name`);
  return JSON.stringify(rows.map(row => [row.name, row.version]));
}

export function staleStage() {
  return new ApiGuardError(409, "stage_inputs_changed", "Source data or a plan decision changed during this step. Retry using the current workspace.");
}

/** Keep direct module callers working while the kernel collects writes for atomic publication. */
export async function stageWrite(ctx: ModuleContext, write: () => Promise<void>): Promise<void> {
  if (ctx.replay?.evaluation) return;
  if (ctx.deferWrite) ctx.deferWrite(write);
  else await withWorkspaceTransaction(write);
}
