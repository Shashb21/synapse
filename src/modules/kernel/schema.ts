import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

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

export const promptBaselines = pgTable(
  "prompt_baselines",
  {
    id: text("id").primaryKey(),
    stage: text("stage").notNull(),
    prompt_version: text("prompt_version").notNull(),
    module_id: text("module_id").notNull(),
    module_version: text("module_version").notNull(),
    metrics: jsonb("metrics").notNull(),
    composite: numeric("composite").notNull(),
    recorded_at: text("recorded_at").notNull(),
    note: text("note"),
  },
  (table) => ({
    stageVersion: unique().on(table.stage, table.prompt_version),
  }),
);

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

/** Retired (KAN-65): LLM provider OAuth was removed. Nothing reads or writes this table. */
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
  proposal_kind: text("proposal_kind").notNull().default("new"),
  target_tactic_id: text("target_tactic_id"),
  expansion_id: text("expansion_id"),
  expansion_scope: jsonb("expansion_scope"),
  reviewed_parent: jsonb("reviewed_parent"),
  comparative_rationale: text("comparative_rationale").notNull().default(""),
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

/** Frozen evidence remains available even when model generation fails. */
export const promptRevisionCohorts = pgTable("prompt_revision_cohorts", {
  id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(), stage: text("stage").notNull(),
  created_at: text("created_at").notNull(), training_ids: jsonb("training_ids").notNull(),
  heldout_ids: jsonb("heldout_ids").notNull(), excluded_ids: jsonb("excluded_ids").notNull(),
  examples: jsonb("examples").notNull(), replay_exclusions: jsonb("replay_exclusions").notNull(),
  gold_reservation: jsonb("gold_reservation"),
});

/** Instruction/evidence columns are immutable; only lifecycle state may change. */
export const promptRevisions = pgTable("prompt_revisions", {
  id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(), stage: text("stage").notNull(),
  parent_revision: text("parent_revision").notNull(), instruction_text: text("instruction_text").notNull(),
  creator: jsonb("creator").notNull(), created_at: text("created_at").notNull(), state: text("state").notNull(),
  cohort_id: text("cohort_id").notNull(), training_ids: jsonb("training_ids").notNull(), heldout_ids: jsonb("heldout_ids").notNull(),
  excluded_ids: jsonb("excluded_ids").notNull(), generation_run_id: text("generation_run_id").notNull(),
  model: text("model"), provider_id: text("provider_id"),
});

/** Apply whole statements: trigger bodies contain internal semicolons. */
/** The platform audit log (KAN-87). Append-only: AUDIT_DDL makes the database refuse changes. */
export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor_principal: text("actor_principal").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_role: text("actor_role"),
  customer_id: text("customer_id"),
  workspace_id: text("workspace_id"),
  category: text("category").notNull(),
  action: text("action").notNull(),
  entity_type: text("entity_type"),
  entity_id: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  rationale: text("rationale"),
  request_id: text("request_id"),
  run_id: text("run_id"),
  ip: text("ip"),
  user_agent: text("user_agent"),
  meta: jsonb("meta"),
});

/**
 * audit_events DDL (KAN-87). The triggers make the log append-only at the
 * database level: UPDATE, DELETE and TRUNCATE all raise, whatever code or
 * database user tries them.
 */
export const AUDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS audit_events (
    id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
    actor_principal text NOT NULL, actor_name text NOT NULL, actor_role text,
    customer_id text, workspace_id text,
    category text NOT NULL CHECK (category IN ('admin', 'auth', 'config', 'workspace', 'plan', 'ai')),
    action text NOT NULL, entity_type text, entity_id text,
    before jsonb, after jsonb, rationale text,
    request_id text, run_id text, ip text, user_agent text, meta jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events(at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_events_category ON audit_events(category, at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_events_workspace ON audit_events(workspace_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events(actor_principal, at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_events_entity ON audit_events(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS audit_events_request ON audit_events(request_id)`,
  `CREATE OR REPLACE FUNCTION public.audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'The audit log is append-only: % is not allowed on audit_events', TG_OP;
  END; $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_events_no_change') THEN
      CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_only();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_events_no_truncate') THEN
      CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_append_only();
    END IF;
  END $$`,
];

export const PROMPT_REVISION_DDL = [
  `CREATE TABLE IF NOT EXISTS prompt_revision_cohorts (
    id text PRIMARY KEY, workspace_id text NOT NULL, stage text NOT NULL, created_at text NOT NULL,
    training_ids jsonb NOT NULL, heldout_ids jsonb NOT NULL, excluded_ids jsonb NOT NULL,
    examples jsonb NOT NULL, replay_exclusions jsonb NOT NULL
  )`,
  `ALTER TABLE prompt_revision_cohorts ADD COLUMN IF NOT EXISTS gold_reservation jsonb`,
  `CREATE TABLE IF NOT EXISTS prompt_revisions (
    id text PRIMARY KEY, workspace_id text NOT NULL, stage text NOT NULL, parent_revision text NOT NULL,
    instruction_text text NOT NULL, creator jsonb NOT NULL, created_at text NOT NULL,
    state text NOT NULL CHECK (state IN ('candidate', 'evaluated', 'active', 'superseded')),
    cohort_id text NOT NULL REFERENCES prompt_revision_cohorts(id), training_ids jsonb NOT NULL,
    heldout_ids jsonb NOT NULL, excluded_ids jsonb NOT NULL, generation_run_id text NOT NULL,
    model text, provider_id text
  )`,
  `CREATE INDEX IF NOT EXISTS prompt_revisions_workspace_stage ON prompt_revisions(workspace_id, stage)`,
  `CREATE OR REPLACE FUNCTION public.protect_prompt_revision_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Prompt revision evidence is immutable'; END IF;
    IF TG_TABLE_NAME = 'prompt_revision_cohorts' OR (to_jsonb(OLD) - 'state') IS DISTINCT FROM (to_jsonb(NEW) - 'state') THEN
      RAISE EXCEPTION 'Prompt revision evidence is immutable';
    END IF;
    RETURN NEW;
  END; $$`,
  `CREATE OR REPLACE TRIGGER prompt_revisions_immutable BEFORE UPDATE OR DELETE ON prompt_revisions FOR EACH ROW EXECUTE FUNCTION public.protect_prompt_revision_evidence()`,
  `CREATE OR REPLACE TRIGGER prompt_revision_cohorts_immutable BEFORE UPDATE OR DELETE ON prompt_revision_cohorts FOR EACH ROW EXECUTE FUNCTION public.protect_prompt_revision_evidence()`,
];

/** Immutable full replay/evaluation evidence and a workspace/stage active pointer. */
export const PROMPT_EVALUATION_DDL = [
 `CREATE TABLE IF NOT EXISTS prompt_replay_snapshots (run_id text PRIMARY KEY, workspace_id text NOT NULL, stage text NOT NULL, snapshot jsonb NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS prompt_revision_evaluations (id text PRIMARY KEY, workspace_id text NOT NULL, revision_id text NOT NULL, created_at text NOT NULL, evidence jsonb NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS prompt_active_revisions (workspace_id text NOT NULL, stage text NOT NULL, revision_id text, generation integer NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,stage))`,
 `CREATE TABLE IF NOT EXISTS prompt_revision_history (id text PRIMARY KEY, workspace_id text NOT NULL, stage text NOT NULL, before_id text, after_id text, evaluation_id text, actor jsonb NOT NULL, action text NOT NULL, created_at text NOT NULL, generation integer NOT NULL)`,
 `CREATE OR REPLACE FUNCTION immutable_prompt_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Prompt evidence is immutable'; END $$`,
 ...['prompt_replay_snapshots','prompt_revision_evaluations','prompt_revision_history'].map(table=>`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${table}_immutable') THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION immutable_prompt_evidence(); END IF; END $$`),
];
