import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Platform tables owned by the kernel and the cross-cutting modules. The IEGP
 * domain tables live in `src/lib/iegp/schema.ts`; nothing here duplicates them.
 */

export const moduleRuns = pgTable("module_runs", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  stage: text("stage").notNull(),
  module_id: text("module_id").notNull(),
  module_version: text("module_version").notNull(),
  status: text("status").notNull(),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at"),
  duration_ms: integer("duration_ms"),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  summary: text("summary"),
  error: text("error"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  steps: jsonb("steps").notNull(),
  route: jsonb("route"),
  evals: jsonb("evals"),
});

export const editRecords = pgTable("edit_records", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  workspace_id: text("workspace_id").notNull(),
  stage: text("stage").notNull(),
  entity_type: text("entity_type").notNull(),
  entity_id: text("entity_id").notNull(),
  field: text("field").notNull(),
  action: text("action").notNull(),
  before: text("before"),
  after: text("after"),
  rationale: text("rationale").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
});

export const hillclimbSignals = pgTable("hillclimb_signals", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  stage: text("stage").notNull(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  rationale: text("rationale").notNull(),
  weight: integer("weight").notNull().default(1),
  status: text("status").notNull().default("open"),
  payload: jsonb("payload"),
});

export const evalRuns = pgTable("eval_runs", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  stage: text("stage").notNull(),
  module_id: text("module_id").notNull(),
  module_version: text("module_version").notNull(),
  run_id: text("run_id"),
  passed: boolean("passed").notNull().default(true),
  metrics: jsonb("metrics").notNull(),
  note: text("note"),
});

export const routingConfig = pgTable("routing_config", {
  stage: text("stage").primaryKey(),
  provider_id: text("provider_id").notNull(),
  model: text("model").notNull(),
  params: jsonb("params").notNull(),
  fallbacks: jsonb("fallbacks").notNull(),
  updated_by: text("updated_by").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const stageModules = pgTable("stage_modules", {
  stage: text("stage").primaryKey(),
  module_id: text("module_id").notNull(),
  activated_by: text("activated_by").notNull(),
  activated_at: text("activated_at").notNull(),
});

export const oauthConnections = pgTable("oauth_connections", {
  provider_id: text("provider_id").primaryKey(),
  status: text("status").notNull(),
  account_label: text("account_label"),
  scopes: jsonb("scopes").notNull(),
  access_token: text("access_token"),
  refresh_token: text("refresh_token"),
  expires_at: text("expires_at"),
  connected_by: text("connected_by"),
  connected_at: text("connected_at"),
  detail: text("detail"),
});

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  provider_id: text("provider_id").notNull(),
  subject: text("subject").notNull(),
  email: text("email"),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  role: text("role").notNull(),
  created_at: text("created_at").notNull(),
  expires_at: text("expires_at").notNull(),
});

export const priorityAxes = pgTable("priority_axes", {
  id: text("id").primaryKey(),
  config: jsonb("config").notNull(),
  updated_by: text("updated_by").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const priorityPlacements = pgTable("priority_placements", {
  gap_id: text("gap_id").primaryKey(),
  axis_scores: jsonb("axis_scores").notNull(),
  suggested_band: text("suggested_band").notNull(),
  suggested_rationale: text("suggested_rationale").notNull(),
  band: text("band"),
  validated: boolean("validated").notNull().default(false),
  rationale: text("rationale"),
  actor_name: text("actor_name"),
  actor_function: text("actor_function"),
  at: text("at").notNull(),
});

export const ideationProposals = pgTable("ideation_proposals", {
  id: text("id").primaryKey(),
  gap_id: text("gap_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  rationale: text("rationale").notNull(),
  evidence_question: text("evidence_question").notNull(),
  design: jsonb("design").notNull(),
  status: text("status").notNull().default("proposed"),
  critic_note: text("critic_note"),
  judge_score: integer("judge_score").notNull().default(0),
  created_at: text("created_at").notNull(),
  decided_by: text("decided_by"),
  decided_at: text("decided_at"),
  decision_rationale: text("decision_rationale"),
  tactic_id: text("tactic_id"),
});

export const timelineActivities = pgTable("timeline_activities", {
  id: text("id").primaryKey(),
  tactic_id: text("tactic_id").notNull(),
  gap_ids: jsonb("gap_ids").notNull(),
  lane: text("lane").notNull(),
  start_date: text("start_date").notNull(),
  end_date: text("end_date").notNull(),
  readout_date: text("readout_date"),
  depends_on: jsonb("depends_on").notNull(),
  band: text("band"),
  meta: jsonb("meta").notNull(),
  updated_by: text("updated_by"),
  updated_at: text("updated_at").notNull(),
});

export const iegpPlans = pgTable("iegp_plans", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  note: text("note"),
  saved_by: text("saved_by").notNull(),
  saved_function: text("saved_function").notNull(),
  saved_at: text("saved_at").notNull(),
});
