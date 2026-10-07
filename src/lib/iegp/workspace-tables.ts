import { SOURCE_FILES_DDL } from "@/modules/stages/s0-upload/schema";
import { PARSED_DOCUMENTS_DDL } from "@/modules/stages/s1-parse/schema";
import { GAP_CANDIDATES_DDL } from "@/modules/stages/s2-gap-extract/schema";
import { TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL } from "@/modules/stages/s3-tactic-extract/schema";
import { MAPPING_CANDIDATES_DDL } from "@/modules/stages/s4-kg-mapping/schema";

/**
 * Every table a workspace schema holds beyond the core IEGP tables, in one
 * place with no runtime dependencies, so `db.ts` creates them all when a schema
 * is bootstrapped, whichever modules the process happens to have loaded.
 * Keep this file free of imports that reach back into `@/lib/iegp/db`.
 */

function split(ddl: string): string[] {
  return ddl.split(";").map((s) => s.trim()).filter(Boolean);
}

/** Kernel-owned workspace tables: run history, edits, hillclimb, S8–S10 artifacts, plans. */
export const KERNEL_WORKSPACE_DDL = `
CREATE TABLE IF NOT EXISTS module_runs (
  id text PRIMARY KEY, workspace_id text NOT NULL, stage text NOT NULL,
  module_id text NOT NULL, module_version text NOT NULL, status text NOT NULL,
  started_at text NOT NULL, finished_at text, duration_ms integer,
  actor_name text NOT NULL, actor_function text NOT NULL,
  summary text, error text,
  input jsonb NOT NULL, output jsonb, steps jsonb NOT NULL,
  route jsonb, evals jsonb
);
CREATE TABLE IF NOT EXISTS edit_records (
  id text PRIMARY KEY, at text NOT NULL, workspace_id text NOT NULL,
  stage text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  field text NOT NULL, action text NOT NULL, before text, after text,
  rationale text NOT NULL, actor_name text NOT NULL, actor_function text NOT NULL
);
CREATE TABLE IF NOT EXISTS hillclimb_signals (
  id text PRIMARY KEY, at text NOT NULL, stage text NOT NULL, kind text NOT NULL,
  subject text NOT NULL, rationale text NOT NULL,
  weight integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open',
  payload jsonb
);
CREATE TABLE IF NOT EXISTS priority_axes (
  id text PRIMARY KEY, config jsonb NOT NULL,
  updated_by text NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS priority_placements (
  gap_id text PRIMARY KEY, axis_scores jsonb NOT NULL,
  suggested_band text NOT NULL, suggested_rationale text NOT NULL,
  band text, validated boolean NOT NULL DEFAULT false, rationale text,
  actor_name text, actor_function text, at text NOT NULL
);
CREATE TABLE IF NOT EXISTS ideation_proposals (
  id text PRIMARY KEY, gap_id text NOT NULL, name text NOT NULL, type text NOT NULL,
  rationale text NOT NULL, evidence_question text NOT NULL, design jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed', critic_note text,
  judge_score integer NOT NULL DEFAULT 0, created_at text NOT NULL,
  decided_by text, decided_at text, decision_rationale text, tactic_id text
);
CREATE TABLE IF NOT EXISTS timeline_activities (
  id text PRIMARY KEY, tactic_id text NOT NULL, gap_ids jsonb NOT NULL,
  lane text NOT NULL, start_date text NOT NULL, end_date text NOT NULL,
  readout_date text, depends_on jsonb NOT NULL, band text, meta jsonb NOT NULL,
  updated_by text, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS iegp_plans (
  id text PRIMARY KEY, version integer NOT NULL, status text NOT NULL,
  snapshot jsonb NOT NULL, note text, saved_by text NOT NULL,
  saved_function text NOT NULL, saved_at text NOT NULL
);
`;

/** Human edits to S1 source blocks (see `source-blocks.ts`), with their migrations. */
export const SOURCE_BLOCKS_DDL = [
  `CREATE TABLE IF NOT EXISTS source_block_meta (
    block_id text PRIMARY KEY, source_id text NOT NULL, origin text NOT NULL,
    locked boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
    position double precision, current_text text NOT NULL,
    original_text text, original_heading text,
    edited_by text, edited_function text, edited_at text
  )`,
  `CREATE TABLE IF NOT EXISTS source_dropped_units (
    id text PRIMARY KEY, source_id text NOT NULL, location text NOT NULL,
    reason text NOT NULL, text text NOT NULL, restored_block_id text, created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_stakeholder_meta (
    source_id text PRIMARY KEY, llm_function text, llm_rationale text, llm_at text,
    override_function text, override_rationale text, override_by text, override_at text
  )`,
  "ALTER TABLE source_block_meta ADD COLUMN IF NOT EXISTS source_generation text",
  "ALTER TABLE source_dropped_units ADD COLUMN IF NOT EXISTS source_generation text",
  "ALTER TABLE source_stakeholder_meta ADD COLUMN IF NOT EXISTS source_generation text",
];

/** The Room: speaker notes and the presenter's current slide (see `lib/room/store.ts`). */
export const ROOM_DDL = [
  `CREATE TABLE IF NOT EXISTS room_notes (
    slide_id text PRIMARY KEY, notes text NOT NULL, updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS room_presenter (
    id text PRIMARY KEY, slide_id text NOT NULL, href text NOT NULL,
    rev integer NOT NULL, updated_at text NOT NULL
  )`,
];

/** Walkthrough progress, one row per person (see `walkthrough.ts`). */
export const WALKTHROUGH_DDL = [
  "CREATE TABLE IF NOT EXISTS walkthrough_progress (principal text PRIMARY KEY, step integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active', updated_at text NOT NULL)",
];

/** Columns S8 added to priority_placements for hand-set axes and bands. */
export const S8_PLACEMENT_COLUMNS_DDL = [
  "ALTER TABLE priority_placements ADD COLUMN IF NOT EXISTS human_axes jsonb NOT NULL DEFAULT '[]'::jsonb",
  "ALTER TABLE priority_placements ADD COLUMN IF NOT EXISTS human_band boolean NOT NULL DEFAULT false",
];

/** Tables owned by the built-in stage modules (their `migrations`). */
export const STAGE_MODULE_DDL = [
  SOURCE_FILES_DDL,
  PARSED_DOCUMENTS_DDL,
  GAP_CANDIDATES_DDL,
  TACTIC_CANDIDATES_DDL,
  TACTIC_CANDIDATES_DUPLICATE_DDL,
  MAPPING_CANDIDATES_DDL,
];

/** Every statement, in order, that brings a schema's non-core tables up to date. */
export function workspaceTableStatements(): string[] {
  return [
    ...split(KERNEL_WORKSPACE_DDL),
    ...S8_PLACEMENT_COLUMNS_DDL,
    ...SOURCE_BLOCKS_DDL,
    ...ROOM_DDL,
    ...WALKTHROUGH_DDL,
    ...STAGE_MODULE_DDL.flatMap(split),
  ];
}
