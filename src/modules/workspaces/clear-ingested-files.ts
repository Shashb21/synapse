/** Clear current ingestion and its proven automated creations, preserving manual work and history. */
import { sql } from "drizzle-orm";
import { currentSchemaName, withWorkspaceTransaction } from "@/lib/iegp/db";
import { db } from "@/modules/kernel/db";
import { syncComputedGapStatuses } from "@/lib/iegp/store";
import { ApiGuardError } from "@/modules/auth/api-guard";

/**
 * Remove current ingestion under the ingestion runner's transaction lock.
 *
 * Only successful job/run outputs establish automated creation ownership. Candidate
 * attachments may point at manual records and must never establish ownership.
 * Unclassified legacy records are retained. IDs and historical records are never reset.
 * Throws ApiGuardError when an ingestion step is running; any failure rolls back all writes.
 */
export async function clearIngestedFiles(): Promise<void> {
  const schema = await currentSchemaName();
  await withWorkspaceTransaction(async () => {
    const locked = await db().execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0)) as locked`);
    if (!locked[0]?.locked) throw new ApiGuardError(409, "ingest_busy", "An ingestion step is still running. Wait for it to finish, then retry clearing files.");
    // Temporary sets live only in this transaction and schema. Missing/truncated
    // historical outputs contribute no IDs, so uncertain legacy work is preserved.
    await db().execute(sql`create temporary table clear_gap_ids on commit drop as
      select distinct jsonb_array_elements_text(case when jsonb_typeof(checkpoint->'result'->'gap_ids') = 'array' then checkpoint->'result'->'gap_ids' else '[]'::jsonb end) as id from ingestion_jobs
      union select jsonb_array_elements_text(case when jsonb_typeof(output->'committed_gap_ids') = 'array' then output->'committed_gap_ids' else '[]'::jsonb end) from module_runs where stage = 'S2' and status = 'ok'`);
    await db().execute(sql`create temporary table clear_tactic_ids on commit drop as
      select distinct jsonb_array_elements_text(case when jsonb_typeof(checkpoint->'result'->'tactic_ids') = 'array' then checkpoint->'result'->'tactic_ids' else '[]'::jsonb end) as id from ingestion_jobs
      union select jsonb_array_elements_text(case when jsonb_typeof(output->'committed_tactic_ids') = 'array' then output->'committed_tactic_ids' else '[]'::jsonb end) from module_runs where stage = 'S3' and status = 'ok'`);
    // A manually promoted candidate creates a manual need without run provenance.
    await db().execute(sql`create temporary table clear_need_ids on commit drop as
      select id from needs where source_id in (select id from sources)
      and (run_id is not null or candidate_row_id is not null)`);
    await db().execute(sql`create temporary table clear_residual_ids on commit drop as
      select id from residuals where gap_id in (select id from clear_gap_ids) or created_gap_id in (select id from clear_gap_ids)`);
    await db().execute(sql`create temporary table clear_expansion_ids on commit drop as
      select id from tactic_expansions where tactic_id in (select id from clear_tactic_ids)
      or (jsonb_array_length(gap_ids) > 0 and not exists (select 1 from jsonb_array_elements_text(gap_ids) g(id) where g.id not in (select id from clear_gap_ids)))`);
    await db().execute(sql`create temporary table clear_coverage_ids on commit drop as
      select id from coverages where gap_id in (select id from clear_gap_ids) or tactic_id in (select id from clear_tactic_ids) or expansion_id in (select id from clear_expansion_ids)`);
    await db().execute(sql`create temporary table clear_timeline_ids on commit drop as
      select id from timeline_activities where tactic_id in (select id from clear_tactic_ids)
      or (jsonb_array_length(gap_ids) > 0 and not exists (select 1 from jsonb_array_elements_text(gap_ids) g(id) where g.id not in (select id from clear_gap_ids)))`);

    // Source attachments on retained manual records are detached, leaving their
    // authored statements intact. Source-backed quotes are current evidence.
    await db().execute(sql`update needs set source_id = '', source_quote = '', run_id = null, candidate_row_id = null, block_id = null where source_id in (select id from sources)`);
    // Free-text quote/title matches do not establish provenance. Only an
    // explicit reference to a current source permits detaching these fields.
    await db().execute(sql`update tactics set
      source_quote = case when exists (select 1 from tactic_source_references r
        join sources s on s.id = r.source_id where r.tactic_id = tactics.id and r.source_quote = tactics.source_quote)
        then '' else source_quote end,
      data_source = case when exists (select 1 from tactic_source_references r
        join sources s on s.id = r.source_id where r.tactic_id = tactics.id and tactics.data_source in (s.id, s.title))
        then '' else data_source end
      where id in (select tactic_id from tactic_source_references where source_id in (select id from sources))`);
    await db().execute(sql`delete from need_gap_links where need_id in (select id from clear_need_ids) or gap_id in (select id from clear_gap_ids)`);
    await db().execute(sql`delete from needs where id in (select id from clear_need_ids)`);
    // Promote a surviving supporting need if its primary evidence was removed.
    await db().execute(sql`update need_gap_links l set role = 'primary' from
      (select gap_id, min(need_id) as need_id from need_gap_links where gap_id not in
        (select gap_id from need_gap_links where role = 'primary') group by gap_id) p
      where l.gap_id = p.gap_id and l.need_id = p.need_id`);
    await db().execute(sql`update gaps set new_source_at = null, new_source_need_id = null
      where new_source_need_id in (select id from clear_need_ids) or new_source_need_id not in (select id from needs)`);
    await db().execute(sql`update gaps set parent_gap_id = null where parent_gap_id in (select id from clear_gap_ids)`);
    await db().execute(sql`update gaps set origin_gap_id = null where origin_gap_id in (select id from clear_gap_ids)`);
    await db().execute(sql`update gaps set related_gap_ids = coalesce((select jsonb_agg(v) from jsonb_array_elements_text(related_gap_ids) v where v not in (select id from clear_gap_ids)), '[]'::jsonb)`);

    // Current relational and JSON references have no database cascades.
    const deletions = [
      "delete from coverages where id in (select id from clear_coverage_ids)",
      "delete from mapping_suggestions where gap_id in (select id from clear_gap_ids) or tactic_id in (select id from clear_tactic_ids)",
      "delete from residual_gap_suggestions where parent_gap_id in (select id from clear_gap_ids)",
      "delete from priorities where residual_id in (select id from clear_residual_ids)",
      "delete from residuals where id in (select id from clear_residual_ids)",
      "delete from breakout_group_gaps where gap_id in (select id from clear_gap_ids)",
      "delete from priority_placements where gap_id in (select id from clear_gap_ids)",
      "delete from ideation_proposals where gap_id in (select id from clear_gap_ids) or tactic_id in (select id from clear_tactic_ids) or target_tactic_id in (select id from clear_tactic_ids) or expansion_id in (select id from clear_expansion_ids)",
      "delete from timeline_activities where id in (select id from clear_timeline_ids)",
      "delete from tactic_expansions where id in (select id from clear_expansion_ids)",
      "delete from roadmap where tactic_id in (select id from clear_tactic_ids)",
      "delete from gold_needs where source_id in (select id from sources)",
      "delete from gold_coverages where gap_id in (select id from clear_gap_ids) or tactic_id in (select id from clear_tactic_ids)",
      "delete from gaps where id in (select id from clear_gap_ids)",
      "delete from tactics where id in (select id from clear_tactic_ids)",
    ];
    for (const statement of deletions) await db().execute(sql.raw(statement));
    await db().execute(sql`update timeline_activities set gap_ids = coalesce((select jsonb_agg(v) from jsonb_array_elements_text(gap_ids) v where v not in (select id from clear_gap_ids)), '[]'::jsonb), depends_on = coalesce((select jsonb_agg(v) from jsonb_array_elements_text(depends_on) v where v not in (select id from clear_timeline_ids)), '[]'::jsonb)`);
    // Metadata drives proposed dependencies and their explanations in the editor.
    // Preserve other scheduling metadata and omit absent optional fields.
    await db().execute(sql`update timeline_activities set meta =
      (meta - 'proposed_dependencies' - 'dependency_reasons')
      || case when meta ? 'proposed_dependencies' then jsonb_build_object('proposed_dependencies',
        coalesce((select jsonb_agg(v) from jsonb_array_elements(meta->'proposed_dependencies') v
          where v->>'id' not in (select id from clear_timeline_ids)), '[]'::jsonb)) else '{}'::jsonb end
      || case when meta ? 'dependency_reasons' then jsonb_build_object('dependency_reasons',
        coalesce((select jsonb_object_agg(key, value) from jsonb_each(meta->'dependency_reasons')
          where key not in (select id from clear_timeline_ids)), '{}'::jsonb)) else '{}'::jsonb end`);
    await db().execute(sql`update tactic_expansions set gap_ids = coalesce((select jsonb_agg(v) from jsonb_array_elements_text(gap_ids) v where v not in (select id from clear_gap_ids)), '[]'::jsonb)`);
    await db().execute(sql`update roadmap set residual_ids = coalesce((select jsonb_agg(v) from jsonb_array_elements_text(residual_ids) v where v not in (select id from clear_residual_ids)), '[]'::jsonb)`);
    // All current source material, including human-edited blocks, is in scope.
    // Machine mapping proposals are current candidate state even when both
    // endpoints survive; committed manual coverage rows remain above.
    for (const table of ["source_comparisons", "gap_suggestions", "tactic_suggestions", "tactic_source_references", "mapping_candidates", "gap_candidates", "tactic_candidates", "source_block_meta", "source_dropped_units", "source_stakeholder_meta", "source_blocks", "parsed_documents", "source_files", "sources", "ingestion_jobs"]) {
      await db().execute(sql.raw(`delete from ${table}`));
    }
    await syncComputedGapStatuses();
  });
}
