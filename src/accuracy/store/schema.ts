import { boolean, index, integer, jsonb, numeric, pgTable, text, unique } from "drizzle-orm/pg-core";

/** Multi-tenant accuracy stack — one workspace = one IEGP. */

export const accuracyOrganizations = pgTable("accuracy_organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull(),
});

export const accuracyWorkspaces = pgTable("accuracy_workspaces", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  planning_context: jsonb("planning_context"),
  created_at: text("created_at").notNull(),
  /** Soft-hide from default workspace lists. Null = active. */
  archived_at: text("archived_at"),
});

export const accuracySourceFiles = pgTable("accuracy_source_files", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  org_id: text("org_id").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  doc_role: text("doc_role").notNull().default("other"),
  checksum: text("checksum").notNull(),
  uploaded_at: text("uploaded_at").notNull(),
  reference_pack_id: text("reference_pack_id"),
});

export const accuracyParseBlocks = pgTable("accuracy_parse_blocks", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  index: integer("index").notNull(),
  kind: text("kind").notNull(),
  heading: text("heading"),
  text: text("text").notNull(),
  parser: text("parser").notNull(),
  created_at: text("created_at").notNull(),
});

export const accuracyClaims = pgTable("accuracy_claims", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  claim_type: text("claim_type").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  validated: boolean("validated").notNull().default(false),
  source_file_id: text("source_file_id"),
  metadata: jsonb("metadata").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const accuracyProvenance = pgTable("accuracy_provenance", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  claim_id: text("claim_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  block_id: text("block_id").notNull(),
  quote: text("quote").notNull(),
});

/** Promote / dismiss actions for completeness-audit miss flags (hillclimb rationales). */
export const accuracyMissFlagActions = pgTable("accuracy_miss_flag_actions", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  block_id: text("block_id").notNull(),
  action: text("action").notNull(),
  suggested: text("suggested"),
  claim_id: text("claim_id"),
  rationale: text("rationale").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  created_at: text("created_at").notNull(),
});

export const accuracyCoverageJoins = pgTable("accuracy_coverage_joins", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  gap_id: text("gap_id").notNull(),
  tactic_id: text("tactic_id").notNull(),
  overall: text("overall").notNull(),
  dimensions: jsonb("dimensions").notNull(),
  confidence: numeric("confidence"),
  validated: boolean("validated").notNull().default(false),
  rationale: text("rationale"),
});

export const accuracyModuleRuns = pgTable("accuracy_module_runs", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  workspace_id: text("workspace_id").notNull(),
  call_kind: text("call_kind").notNull(),
  agent_role: text("agent_role").notNull().default("none"),
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
  token_usage: jsonb("token_usage"),
  cost_usd: numeric("cost_usd"),
  evals: jsonb("evals"),
});

/** Immutable snapshots, critiques, and judgments for one accuracy call run. */
export const accuracyAgentEvents = pgTable(
  "accuracy_agent_events",
  {
    id: text("id").primaryKey(),
    run_id: text("run_id").notNull().references(() => accuracyModuleRuns.id, { onDelete: "cascade" }),
    workspace_id: text("workspace_id").notNull(),
    event_type: text("event_type").notNull(),
    iteration: integer("iteration"),
    payload: jsonb("payload").notNull(),
    recorded_at: text("recorded_at").notNull(),
  },
  (table) => ({
    runWorkspace: index("accuracy_agent_events_run_workspace_idx").on(table.run_id, table.workspace_id),
    onePerIteration: unique("accuracy_agent_events_run_type_iteration_key").on(table.run_id, table.event_type, table.iteration),
  }),
);

/** Append-only contributor decisions for individual source-linked omissions. */
export const accuracyOmissionActions = pgTable("accuracy_omission_actions", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  run_id: text("run_id").notNull(),
  issue_id: text("issue_id").notNull(),
  action: text("action").notNull(),
  claim_id: text("claim_id"),
  new_importance: text("new_importance"),
  reason: text("reason").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  created_at: text("created_at").notNull(),
  idempotency_key: text("idempotency_key").notNull(),
  request_fingerprint: text("request_fingerprint").notNull(),
  contributor_statement: text("contributor_statement"),
}, (table) => ({
  requestKey: unique("accuracy_omission_actions_workspace_request_key").on(table.workspace_id, table.idempotency_key),
  history: index("accuracy_omission_actions_history_idx").on(table.workspace_id, table.run_id, table.issue_id),
}));

/** An extraction is applied only after every draft has been persisted. */
export const accuracyExtractionBatches = pgTable("accuracy_extraction_batches", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  requested_kinds: jsonb("requested_kinds").$type<string[]>().notNull(),
  run_ids: jsonb("run_ids").$type<string[]>().notNull(),
  created_claim_ids: jsonb("created_claim_ids").$type<string[]>().notNull(),
  drafts_persisted: boolean("drafts_persisted").notNull().default(false),
  created_at: text("created_at").notNull(),
}, (table) => ({
  source: index("accuracy_extraction_batches_source_idx").on(table.workspace_id, table.source_file_id),
}));

/** Durable reserved operations and responses make a resumed batch retryable. */
export const accuracyResumeJournals = pgTable("accuracy_resume_journals", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  batch_id: text("batch_id").notNull(),
  merge_operation_id: text("merge_operation_id").notNull(),
  merge_state: text("merge_state").notNull().default("reserved"),
  status_operation_id: text("status_operation_id").notNull(),
  status_state: text("status_state").notNull().default("reserved"),
  final_response: jsonb("final_response"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => ({
  batch: unique("accuracy_resume_journals_workspace_batch_key").on(table.workspace_id, table.batch_id),
}));

export const accuracyRoutingConfig = pgTable(
  "accuracy_routing_config",
  {
    call_kind: text("call_kind").notNull(),
    agent_role: text("agent_role").notNull(),
    provider_id: text("provider_id").notNull(),
    model: text("model").notNull(),
    params: jsonb("params").notNull(),
    fallbacks: jsonb("fallbacks").notNull(),
    updated_by: text("updated_by").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    kindRole: unique().on(table.call_kind, table.agent_role),
  }),
);

export const accuracyCallModules = pgTable("accuracy_call_modules", {
  call_kind: text("call_kind").primaryKey(),
  module_id: text("module_id").notNull(),
  activated_by: text("activated_by").notNull(),
  activated_at: text("activated_at").notNull(),
});

/** Versioned save-final / draft snapshots of the Gantt projection for a workspace. */
export const accuracyPlans = pgTable("accuracy_plans", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  note: text("note"),
  saved_by: text("saved_by").notNull(),
  saved_function: text("saved_function").notNull(),
  saved_at: text("saved_at").notNull(),
});

/** Workspace-scoped workshop freeze: inventory + facilitator tags + overlays. */
export const accuracyWorkshopSnapshots = pgTable("accuracy_workshop_snapshots", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  version: integer("version").notNull(),
  scene: text("scene").notNull(),
  payload: jsonb("payload").notNull(),
  note: text("note"),
  saved_by: text("saved_by").notNull(),
  saved_function: text("saved_function").notNull(),
  saved_at: text("saved_at").notNull(),
});

/** One isolated, repeatable accuracy experiment; immutable apart from terminal status. */
export const accuracyExperiments = pgTable("accuracy_experiments", {
  id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(), org_id: text("org_id").notNull(),
  source_workspace_id: text("source_workspace_id").notNull(), source_org_id: text("source_org_id").notNull(), pack_id: text("pack_id").notNull(), pack_fingerprint: text("pack_fingerprint").notNull(),
  evaluator_version: text("evaluator_version").notNull(), source_fingerprint: text("source_fingerprint").notNull(), baseline_fingerprint: text("baseline_fingerprint").notNull(),
  baseline_snapshot: jsonb("baseline_snapshot").notNull(), condition: jsonb("condition").notNull(), status: text("status").notNull(), created_at: text("created_at").notNull(), finished_at: text("finished_at"),
}, (table) => ({ workspace: index("accuracy_experiments_workspace_idx").on(table.workspace_id, table.created_at) }));

/** Append-only snapshots from calls belonging to an experiment. */
export const accuracyExperimentCalls = pgTable("accuracy_experiment_calls", {
  id: text("id").primaryKey(), experiment_id: text("experiment_id").notNull(), workspace_id: text("workspace_id").notNull(), call_id: text("call_id").notNull(),
  call_kind: text("call_kind").notNull(), version_index: integer("version_index").notNull(), input: jsonb("input").notNull(), output: jsonb("output"), output_error: text("output_error"),
  module_version: text("module_version").notNull(), route: jsonb("route").notNull(), recorded_at: text("recorded_at").notNull(),
}, (table) => ({ version: unique("accuracy_experiment_calls_version_key").on(table.experiment_id, table.call_id, table.version_index) }));

/** Append-only evaluator result corresponding to a persisted experiment call version. */
export const accuracyExperimentEvaluations = pgTable("accuracy_experiment_evaluations", {
  id: text("id").primaryKey(), experiment_id: text("experiment_id").notNull(), workspace_id: text("workspace_id").notNull(), call_id: text("call_id").notNull(),
  version_index: integer("version_index").notNull(), evaluator_version: text("evaluator_version").notNull(), evaluation: jsonb("evaluation").notNull(), recorded_at: text("recorded_at").notNull(),
}, (table) => ({ version: unique("accuracy_experiment_evaluations_version_key").on(table.experiment_id, table.call_id, table.version_index) }));

export const ACCURACY_DDL = [
  `CREATE TABLE IF NOT EXISTS accuracy_organizations (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_workspaces (
    id text PRIMARY KEY,
    org_id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    planning_context jsonb,
    created_at text NOT NULL,
    archived_at text
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_source_files (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    org_id text NOT NULL,
    filename text NOT NULL,
    mime text NOT NULL,
    doc_role text NOT NULL DEFAULT 'other',
    checksum text NOT NULL,
    uploaded_at text NOT NULL,
    reference_pack_id text
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_parse_blocks (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    source_file_id text NOT NULL,
    index integer NOT NULL,
    kind text NOT NULL,
    heading text,
    text text NOT NULL,
    parser text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_claims (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    claim_type text NOT NULL,
    statement text NOT NULL,
    status text NOT NULL,
    validated boolean NOT NULL DEFAULT false,
    source_file_id text,
    metadata jsonb NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_provenance (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    claim_id text NOT NULL,
    source_file_id text NOT NULL,
    block_id text NOT NULL,
    quote text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_miss_flag_actions (
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
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_coverage_joins (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    gap_id text NOT NULL,
    tactic_id text NOT NULL,
    overall text NOT NULL,
    dimensions jsonb NOT NULL,
    confidence numeric,
    validated boolean NOT NULL DEFAULT false,
    rationale text
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_module_runs (
    id text PRIMARY KEY,
    org_id text NOT NULL,
    workspace_id text NOT NULL,
    call_kind text NOT NULL,
    agent_role text NOT NULL DEFAULT 'none',
    module_id text NOT NULL,
    module_version text NOT NULL,
    status text NOT NULL,
    started_at text NOT NULL,
    finished_at text,
    duration_ms integer,
    actor_name text NOT NULL,
    actor_function text NOT NULL,
    summary text,
    error text,
    input jsonb NOT NULL,
    output jsonb,
    steps jsonb NOT NULL,
    route jsonb,
    token_usage jsonb,
    cost_usd numeric,
    evals jsonb
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_agent_events (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    event_type text NOT NULL,
    iteration integer,
    payload jsonb NOT NULL,
    recorded_at text NOT NULL,
    CONSTRAINT accuracy_agent_events_run_fk FOREIGN KEY (run_id) REFERENCES accuracy_module_runs(id) ON DELETE CASCADE,
    CONSTRAINT accuracy_agent_events_run_type_iteration_key UNIQUE (run_id, event_type, iteration)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_agent_events_run_workspace_idx ON accuracy_agent_events (run_id, workspace_id)`,
  `CREATE TABLE IF NOT EXISTS accuracy_omission_actions (
    id text PRIMARY KEY, workspace_id text NOT NULL, source_file_id text NOT NULL,
    run_id text NOT NULL, issue_id text NOT NULL, action text NOT NULL,
    claim_id text, new_importance text, reason text NOT NULL, actor_name text NOT NULL,
    actor_function text NOT NULL, created_at text NOT NULL, idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL, contributor_statement text,
    CONSTRAINT accuracy_omission_actions_workspace_request_key UNIQUE (workspace_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_omission_actions_history_idx ON accuracy_omission_actions (workspace_id, run_id, issue_id)`,
  `CREATE TABLE IF NOT EXISTS accuracy_extraction_batches (
    id text PRIMARY KEY, workspace_id text NOT NULL, source_file_id text NOT NULL,
    requested_kinds jsonb NOT NULL, run_ids jsonb NOT NULL, created_claim_ids jsonb NOT NULL,
    drafts_persisted boolean NOT NULL DEFAULT false, created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_extraction_batches_source_idx ON accuracy_extraction_batches (workspace_id, source_file_id)`,
  `CREATE TABLE IF NOT EXISTS accuracy_resume_journals (
    id text PRIMARY KEY, workspace_id text NOT NULL, batch_id text NOT NULL,
    merge_operation_id text NOT NULL, merge_state text NOT NULL DEFAULT 'reserved',
    status_operation_id text NOT NULL, status_state text NOT NULL DEFAULT 'reserved',
    final_response jsonb, created_at text NOT NULL, updated_at text NOT NULL,
    CONSTRAINT accuracy_resume_journals_workspace_batch_key UNIQUE (workspace_id, batch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_routing_config (
    call_kind text NOT NULL,
    agent_role text NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    params jsonb NOT NULL,
    fallbacks jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at text NOT NULL,
    UNIQUE (call_kind, agent_role)
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_call_modules (
    call_kind text PRIMARY KEY,
    module_id text NOT NULL,
    activated_by text NOT NULL,
    activated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_plans (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    snapshot jsonb NOT NULL,
    note text,
    saved_by text NOT NULL,
    saved_function text NOT NULL,
    saved_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_workshop_snapshots (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    version integer NOT NULL,
    scene text NOT NULL,
    payload jsonb NOT NULL,
    note text,
    saved_by text NOT NULL,
    saved_function text NOT NULL,
    saved_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_experiments (
    id text PRIMARY KEY, workspace_id text NOT NULL, org_id text NOT NULL, source_workspace_id text NOT NULL, source_org_id text NOT NULL,
    pack_id text NOT NULL, pack_fingerprint text NOT NULL, evaluator_version text NOT NULL, source_fingerprint text NOT NULL,
    baseline_fingerprint text NOT NULL, baseline_snapshot jsonb NOT NULL, condition jsonb NOT NULL, status text NOT NULL,
    created_at text NOT NULL, finished_at text
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_experiments_workspace_idx ON accuracy_experiments (workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_experiment_calls (
    id text PRIMARY KEY, experiment_id text NOT NULL, workspace_id text NOT NULL, call_id text NOT NULL, call_kind text NOT NULL,
    version_index integer NOT NULL, input jsonb NOT NULL, output jsonb, output_error text, module_version text NOT NULL,
    route jsonb NOT NULL, recorded_at text NOT NULL, UNIQUE (experiment_id, call_id, version_index)
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_experiment_evaluations (
    id text PRIMARY KEY, experiment_id text NOT NULL, workspace_id text NOT NULL, call_id text NOT NULL, version_index integer NOT NULL,
    evaluator_version text NOT NULL, evaluation jsonb NOT NULL, recorded_at text NOT NULL, UNIQUE (experiment_id, call_id, version_index)
  )`,
];

/** Additive ALTERs for already-created tables. Safe to re-run. */
export const ACCURACY_MIGRATIONS = [
  `ALTER TABLE accuracy_experiments ADD COLUMN IF NOT EXISTS source_org_id text`,
  `ALTER TABLE accuracy_omission_actions ADD COLUMN IF NOT EXISTS contributor_statement text`,
  `ALTER TABLE accuracy_workspaces ADD COLUMN IF NOT EXISTS archived_at text`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'accuracy_agent_events_run_fk'
        AND conrelid = 'accuracy_agent_events'::regclass
    ) THEN
      ALTER TABLE accuracy_agent_events ADD CONSTRAINT accuracy_agent_events_run_fk
        FOREIGN KEY (run_id) REFERENCES accuracy_module_runs(id) ON DELETE CASCADE NOT VALID;
    END IF;
  END $$`,
  `DELETE FROM accuracy_agent_events AS event
   WHERE NOT EXISTS (SELECT 1 FROM accuracy_module_runs AS run WHERE run.id = event.run_id)`,
  `ALTER TABLE accuracy_agent_events VALIDATE CONSTRAINT accuracy_agent_events_run_fk`,
];
