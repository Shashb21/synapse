import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
} from "drizzle-orm/pg-core";

export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  inn: text("inn").notNull(),
  indication: text("indication").notNull(),
  geography: text("geography").notNull(),
  wizard_complete: boolean("wizard_complete").notNull().default(false),
  tactics_unlocked: boolean("tactics_unlocked").notNull().default(false),
  setup_complete: boolean("setup_complete").notNull().default(false),
  planning_context: jsonb("planning_context").notNull().default({}),
});

export const objectives = pgTable("objectives", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  lifecycle_stage: text("lifecycle_stage").notNull(),
  indication: text("indication").notNull(),
  geography: text("geography").notNull(),
  strategic_importance: integer("strategic_importance").notNull(),
  key_decision: text("key_decision").notNull(),
  decision_date: text("decision_date").notNull(),
  owner: text("owner").notNull(),
});

export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  title: text("title").notNull(),
  source_type: text("source_type").notNull(),
  stakeholder_function: text("stakeholder_function").notNull(),
  ingested_at: text("ingested_at").notNull(),
  full_text: text("full_text").notNull(),
});

export const sourceBlocks = pgTable("source_blocks", {
  id: text("id").primaryKey(),
  source_id: text("source_id").notNull(),
  heading: text("heading").notNull(),
  text: text("text").notNull(),
  location: text("location").notNull(),
});

export const needs = pgTable("needs", {
  id: text("id").primaryKey(),
  statement: text("statement").notNull(),
  domain: text("domain").notNull(),
  stakeholder: text("stakeholder").notNull(),
  objective_id: text("objective_id").notNull(),
  decision_supported: text("decision_supported").notNull(),
  geography: text("geography").notNull(),
  population: text("population").notNull(),
  intervention: text("intervention").notNull(),
  comparator: text("comparator").notNull(),
  outcome: text("outcome").notNull(),
  timing: text("timing").notNull(),
  source_id: text("source_id").notNull(),
  source_quote: text("source_quote").notNull(),
  confidence: real("confidence").notNull(),
  status: text("status").notNull(),
  lock: jsonb("lock").notNull(),
});

export const gaps = pgTable("gaps", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  statement: text("statement").notNull(),
  domain: text("domain").notNull(),
  objective_id: text("objective_id").notNull(),
  status: text("status").notNull(),
  exclusion_reason: text("exclusion_reason"),
  exclusion_note: text("exclusion_note"),
  lock: jsonb("lock").notNull(),
  parent_gap_id: text("parent_gap_id"),
  computed_status: text("computed_status"),
  status_override: jsonb("status_override"),
  retired: boolean("retired").notNull().default(false),
  human_validated: boolean("human_validated").notNull().default(false),
  parked_at: text("parked_at"),
  parked_reason: text("parked_reason"),
  settings: jsonb("settings").notNull().default([]),
});

export const gapVersions = pgTable("gap_versions", {
  id: text("id").primaryKey(),
  live_gap_id: text("live_gap_id").notNull(),
  retired_gap_id: text("retired_gap_id").notNull(),
  name: text("name").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  domain: text("domain").notNull(),
  event: text("event").notNull(),
  at: text("at").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
});

export const needGapLinks = pgTable(
  "need_gap_links",
  {
    need_id: text("need_id").notNull(),
    gap_id: text("gap_id").notNull(),
    role: text("role").notNull(),
  },
  (t) => [primaryKey({ columns: [t.need_id, t.gap_id] })],
);

export const breakoutGroups = pgTable("breakout_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  note: text("note"),
  created_at: text("created_at").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
});

export const breakoutGroupGaps = pgTable(
  "breakout_group_gaps",
  {
    group_id: text("group_id").notNull(),
    gap_id: text("gap_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.group_id, t.gap_id] })],
);

export const tactics = pgTable("tactics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description").notNull(),
  evidence_question: text("evidence_question").notNull(),
  population: text("population").notNull(),
  intervention: text("intervention").notNull(),
  comparator: text("comparator").notNull(),
  outcomes: text("outcomes").notNull(),
  geography: text("geography").notNull(),
  data_source: text("data_source").notNull(),
  study_design: text("study_design").notNull(),
  lifecycle_stage: text("lifecycle_stage").notNull(),
  status: text("status").notNull(),
  review_status: text("review_status").notNull().default("accepted"),
  start_date: text("start_date"),
  evidence_available: text("evidence_available"),
  owner: text("owner").notNull(),
  function: text("function").notNull(),
  budget: text("budget"),
  intended_use: text("intended_use").notNull(),
  lock: jsonb("lock").notNull(),
});

export const coverages = pgTable("coverages", {
  id: text("id").primaryKey(),
  gap_id: text("gap_id").notNull(),
  tactic_id: text("tactic_id").notNull(),
  dimensions: jsonb("dimensions").notNull(),
  overall: text("overall").notNull(),
  overall_rationale: text("overall_rationale").notNull(),
  overall_lock: jsonb("overall_lock").notNull(),
  stale: boolean("stale").notNull().default(false),
  needs_review: boolean("needs_review").notNull().default(false),
});

export const mappingSuggestions = pgTable(
  "mapping_suggestions",
  {
    gap_id: text("gap_id").notNull(),
    tactic_id: text("tactic_id").notNull(),
    status: text("status").notNull(),
    lock: jsonb("lock").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gap_id, t.tactic_id] })],
);

export const residualGapSuggestions = pgTable("residual_gap_suggestions", {
  parent_gap_id: text("parent_gap_id").primaryKey(),
  statement: text("statement").notNull(),
  reasons: jsonb("reasons").notNull(),
  status: text("status").notNull(),
  lock: jsonb("lock").notNull(),
});

export const residuals = pgTable("residuals", {
  id: text("id").primaryKey(),
  gap_id: text("gap_id").notNull(),
  statement: text("statement").notNull(),
  domain: text("domain").notNull(),
  draft_rationale: text("draft_rationale").notNull(),
  review_status: text("review_status").notNull().default("candidate"),
  created_gap_id: text("created_gap_id"),
  lock: jsonb("lock").notNull(),
});

export const priorities = pgTable("priorities", {
  id: text("id").primaryKey(),
  residual_id: text("residual_id").notNull(),
  suggested_score: integer("suggested_score").notNull(),
  suggested_band: text("suggested_band").notNull(),
  band: text("band").notNull(),
  override_reason: text("override_reason"),
  reasons: jsonb("reasons").notNull(),
  lock: jsonb("lock").notNull(),
});

export const roadmap = pgTable("roadmap", {
  id: text("id").primaryKey(),
  tactic_id: text("tactic_id").notNull(),
  residual_ids: jsonb("residual_ids").notNull(),
  start_date: text("start_date"),
  evidence_available: text("evidence_available"),
  owner: text("owner").notNull(),
  note: text("note"),
  lock: jsonb("lock").notNull(),
});

export const audit = pgTable("audit", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  entity_type: text("entity_type").notNull(),
  entity_id: text("entity_id").notNull(),
  action: text("action").notNull(),
  detail: text("detail").notNull(),
});

export const goldNeeds = pgTable("gold_needs", {
  id: text("id").primaryKey(),
  statement: text("statement").notNull(),
  source_id: text("source_id").notNull(),
  must_find: boolean("must_find").notNull(),
});

export const goldCoverages = pgTable("gold_coverages", {
  id: text("id").primaryKey(),
  gap_id: text("gap_id").notNull(),
  tactic_id: text("tactic_id").notNull(),
  overall: text("overall").notNull(),
});
