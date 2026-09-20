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
  metadata: jsonb("metadata").notNull().default({}),
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
  metadata: jsonb("metadata").notNull().default({}),
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

export const extractRuns = pgTable("extract_runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  created_at: text("created_at").notNull(),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  persist: boolean("persist").notNull().default(false),
  format: text("format").notNull(),
  prompt_version: text("prompt_version").notNull(),
  champion_version: text("champion_version").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  title: text("title").notNull(),
  error: text("error"),
  input: jsonb("input").notNull(),
  result: jsonb("result"),
  metrics: jsonb("metrics"),
  source_id: text("source_id"),
});

export const extractRunSteps = pgTable("extract_run_steps", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  round: integer("round").notNull(),
  role: text("role").notNull(),
  started_at: text("started_at").notNull(),
  ended_at: text("ended_at"),
  latency_ms: integer("latency_ms"),
  request: jsonb("request").notNull(),
  response: jsonb("response"),
  error: text("error"),
});

export const goldGaps = pgTable("gold_gaps", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  statement: text("statement").notNull(),
  domain: text("domain").notNull(),
  source_key: text("source_key").notNull(),
  source_quote: text("source_quote").notNull(),
  must_find: boolean("must_find").notNull(),
  is_gap: boolean("is_gap").notNull(),
  origin: text("origin").notNull(),
  from_gap_id: text("from_gap_id"),
  metadata: jsonb("metadata").notNull().default({}),
  created_at: text("created_at").notNull(),
  actor_name: text("actor_name"),
  actor_function: text("actor_function"),
});

export const gapFeedback = pgTable("gap_feedback", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  gap_id: text("gap_id").notNull(),
  kind: text("kind").notNull(),
  before: jsonb("before").notNull(),
  after: jsonb("after").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  gold_id: text("gold_id"),
  hillclimb_run_id: text("hillclimb_run_id"),
  error: text("error"),
});

export const extractSettings = pgTable("extract_settings", {
  id: text("id").primaryKey(),
  champion_version: text("champion_version").notNull(),
  updated_at: text("updated_at").notNull(),
  last_hillclimb_at: text("last_hillclimb_at"),
  last_metrics: jsonb("last_metrics"),
  last_error: text("last_error"),
});

export const llmCalls = pgTable("llm_calls", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  auth_mode: text("auth_mode").notNull(),
  provider: text("provider"),
  module: text("module"),
  model: text("model").notNull(),
  purpose: text("purpose").notNull(),
  ok: boolean("ok").notNull(),
  http_status: integer("http_status"),
  latency_ms: integer("latency_ms").notNull(),
  input_tokens: integer("input_tokens"),
  output_tokens: integer("output_tokens"),
  cost_usd: real("cost_usd"),
  error: text("error"),
  reauth: text("reauth"),
  request_id: text("request_id"),
  session_id: text("session_id"),
  oauth_source: text("oauth_source"),
  system_chars: integer("system_chars"),
  user_chars: integer("user_chars"),
  system_preview: text("system_preview"),
  user_preview: text("user_preview"),
});

export const llmSettings = pgTable("llm_settings", {
  id: text("id").primaryKey(),
  updated_at: text("updated_at").notNull(),
  config: jsonb("config").notNull(),
});

export const llmReauthEvents = pgTable("llm_reauth_events", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  type: text("type").notNull(),
  error: text("error"),
  expires_at: text("expires_at"),
  request_id: text("request_id"),
});

export const extractPromptVersions = pgTable("extract_prompt_versions", {
  version: text("version").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  system_prompt: text("system_prompt").notNull(),
  parent_version: text("parent_version"),
  prompt_patch: text("prompt_patch"),
  origin: text("origin").notNull(),
  created_at: text("created_at").notNull(),
});
