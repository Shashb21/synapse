import type { SourceProgress } from "../domain/source-pages";
import { boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";

/** Multi-tenant accuracy stack — one workspace = one IEGP. */

export const accuracyOrganizations = pgTable("accuracy_organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull(),
});

/** Explicit organization access for authenticated identity-provider subjects. */
export const accuracyOrganizationGrants = pgTable("accuracy_organization_grants", {
  subject: text("subject").notNull(),
  org_id: text("org_id").notNull(),
}, (table) => ({ subjectOrg: unique("accuracy_organization_grants_subject_org_key").on(table.subject, table.org_id) }));

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

/**
 * Completeness-critic verdicts per parse block, so Review does not re-ask the
 * model for text it has already judged. Keyed by block text hash.
 */
export const accuracyCompletenessVerdicts = pgTable("accuracy_completeness_verdicts", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  block_id: text("block_id").notNull(),
  text_hash: text("text_hash").notNull(),
  /** Ledger the verdict was judged against. */
  ledger_digest: text("ledger_digest").notNull(),
  missed: boolean("missed").notNull(),
  claim_type: text("claim_type"),
  rationale: text("rationale").notNull(),
  run_id: text("run_id").notNull(),
  judged_at: text("judged_at").notNull(),
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
}, (table) => ({ pair: unique("accuracy_coverage_pair_key").on(table.workspace_id, table.gap_id, table.tactic_id) }));

/** Workspace-owned S8 decisions and saved Accuracy matrix configuration. */
export const accuracyPriorityPlacements = pgTable("accuracy_priority_placements", {
  workspace_id: text("workspace_id").notNull(), gap_id: text("gap_id").notNull(),
  data: jsonb("data").notNull(),
}, table => ({ key: primaryKey({ columns: [table.workspace_id, table.gap_id] }) }));
export const accuracyPriorityConfigs = pgTable("accuracy_priority_configs", {
  workspace_id: text("workspace_id").primaryKey(), data: jsonb("data").notNull(),
});

/** One split-specific reversible snapshot and its append-only human audit. */
export const accuracySplitOperations = pgTable("accuracy_split_operations", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  operation_key: text("operation_key").notNull(),
  request_fingerprint: text("request_fingerprint").notNull(),
  parent_gap_id: text("parent_gap_id").notNull(),
  addressed_gap_id: text("addressed_gap_id").notNull(),
  open_residual_gap_id: text("open_residual_gap_id").notNull(),
  state: text("state").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  audit: jsonb("audit").notNull(),
  created_at: text("created_at").notNull(),
  rolled_back_at: text("rolled_back_at"),
}, (table) => ({ retry: unique("accuracy_split_retry_key").on(table.workspace_id, table.operation_key) }));

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
  evaluation_context: text("evaluation_context").notNull().default("production"),
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

/** Immutable generated alternatives, retaining the claim that first owned each origin. */
export const accuracyItemVersions = pgTable("accuracy_item_versions", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  claim_id: text("claim_id").notNull().references(() => accuracyClaims.id),
  run_id: text("run_id").references(() => accuracyModuleRuns.id),
  human_origin: jsonb("human_origin").$type<import("@/accuracy/domain/item-history").HumanItemOrigin>(),
  snapshot_id: text("snapshot_id").references(() => accuracyAgentEvents.id),
  iteration: integer("iteration"),
  item_index: integer("item_index").notNull(),
  origin_key: text("origin_key").notNull(),
  claim_type: text("claim_type").notNull(),
  fingerprint: text("fingerprint").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  source_file_id: text("source_file_id").notNull().references(() => accuracySourceFiles.id),
  created_at: text("created_at").notNull(),
}, (table) => ({
  origin: unique("accuracy_item_versions_origin_key").on(table.workspace_id, table.origin_key),
  claim: index("accuracy_item_versions_claim_idx").on(table.workspace_id, table.claim_id),
  exact: index("accuracy_item_versions_exact_idx").on(table.workspace_id, table.claim_type, table.source_file_id, table.fingerprint),
}));

/** Immutable whole-set extraction assemblies. */
export const accuracyAssemblies = pgTable("accuracy_assemblies", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  created_at: text("created_at").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  fingerprint: text("fingerprint").notNull(),
  source_file_ids: jsonb("source_file_ids").$type<string[]>().notNull(),
  mappings: jsonb("mappings").$type<Array<{ gap_version_id: string; tactic_version_id: string }>>().notNull(),
  coverage: jsonb("coverage").notNull(),
  extraction_runs: jsonb("extraction_runs"),
  linking_complete: boolean("linking_complete").notNull(),
  output: jsonb("output").notNull(),
  checks: jsonb("checks").notNull(),
  generation_key: text("generation_key"),
}, (table) => ({
  workspace: index("accuracy_assemblies_workspace_idx").on(table.workspace_id, table.created_at),
  generation: unique("accuracy_assemblies_workspace_generation_key").on(table.workspace_id, table.generation_key),
}));

/** Ordered selected version references and resolved immutable lineage. */
export const accuracyAssemblyItems = pgTable("accuracy_assembly_items", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  assembly_id: text("assembly_id").notNull().references(() => accuracyAssemblies.id),
  item_version_id: text("item_version_id").notNull().references(() => accuracyItemVersions.id),
  position: integer("position").notNull(),
  reason: text("reason").notNull(),
  resolved_item: jsonb("resolved_item").notNull(),
}, (table) => ({
  assemblyPosition: unique("accuracy_assembly_items_position_key").on(table.assembly_id, table.position),
  workspace: index("accuracy_assembly_items_workspace_idx").on(table.workspace_id, table.assembly_id),
}));

/** Append-only human approval/rejection decisions for exact assemblies. */
export const accuracyAssemblyReviews = pgTable("accuracy_assembly_reviews", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  assembly_id: text("assembly_id").notNull().references(() => accuracyAssemblies.id),
  fingerprint: text("fingerprint").notNull(),
  checks_fingerprint: text("checks_fingerprint").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale").notNull(),
  advisory_overrides: jsonb("advisory_overrides").$type<Array<{ code: string; item_version_ids: string[]; reason: string }>>().notNull(),
  reviewer_subject: text("reviewer_subject").notNull(),
  reviewer_provider: text("reviewer_provider").notNull(),
  reviewer_actor_name: text("reviewer_actor_name").notNull(),
  reviewer_actor_function: text("reviewer_actor_function").notNull(),
  reviewer_role: text("reviewer_role").notNull(),
  created_at: text("created_at").notNull(),
}, (table) => ({
  assembly: index("accuracy_assembly_reviews_assembly_idx").on(table.workspace_id, table.assembly_id, table.created_at),
}));

/** Append-only observations about exact approved output consumed by a production run. */
export const accuracyAssemblyFeedback = pgTable("accuracy_assembly_feedback", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  assembly_id: text("assembly_id").notNull().references(() => accuracyAssemblies.id),
  assembly_fingerprint: text("assembly_fingerprint").notNull(),
  approval_review_id: text("approval_review_id").notNull().references(() => accuracyAssemblyReviews.id),
  consumer_run_id: text("consumer_run_id").notNull().references(() => accuracyModuleRuns.id),
  selected_item_version_ids: jsonb("selected_item_version_ids").$type<string[]>().notNull(),
  category: text("category").notNull(),
  rationale: text("rationale").notNull(),
  actor_subject: text("actor_subject").notNull(),
  actor_provider: text("actor_provider").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  created_at: text("created_at").notNull(),
}, (table) => ({
  assembly: index("accuracy_assembly_feedback_assembly_idx").on(table.workspace_id, table.assembly_id, table.created_at),
}));

/** Immutable reasoned human change; linking completions publish new assembly heads. */
export const accuracyAssemblyRevisions = pgTable("accuracy_assembly_revisions", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  baseline_assembly_id: text("baseline_assembly_id").notNull().references(() => accuracyAssemblies.id),
  parent_assembly_id: text("parent_assembly_id").notNull().references(() => accuracyAssemblies.id),
  initial_assembly_id: text("initial_assembly_id").notNull().references(() => accuracyAssemblies.id),
  change: jsonb("change").$type<import("@/accuracy/domain/assembly-revision").AssemblyRevision>().notNull(),
});
/** Mutable pointer only; all assemblies and changes remain immutable. */
export const accuracyAssemblyRevisionHeads = pgTable("accuracy_assembly_revision_heads", {
  baseline_assembly_id: text("baseline_assembly_id").primaryKey().references(() => accuracyAssemblies.id),
  workspace_id: text("workspace_id").notNull(),
  assembly_id: text("assembly_id").notNull().references(() => accuracyAssemblies.id),
  revision_id: text("revision_id").notNull().references(() => accuracyAssemblyRevisions.id),
});
/** Append-only linking attempts record incomplete recovery and final checked assemblies. */
export const accuracyAssemblyRevisionAttempts = pgTable("accuracy_assembly_revision_attempts", {
  id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(),
  revision_id: text("revision_id").notNull().references(() => accuracyAssemblyRevisions.id),
  assembly_id: text("assembly_id").notNull().references(() => accuracyAssemblies.id),
  error: text("error"), created_at: text("created_at").notNull(),
});

/** Uncertain identity or ancestry proposal; decisions are separate immutable records. */
export const accuracyItemRelationshipProposals = pgTable("accuracy_item_relationship_proposals", {
  id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(),
  kind: text("kind").notNull(), predecessor_ids: jsonb("predecessor_ids").$type<string[]>().notNull(),
  successor_ids: jsonb("successor_ids").$type<string[]>().notNull(),
  basis_version_ids: jsonb("basis_version_ids").$type<string[]>().notNull(),
  rationale: text("rationale").notNull(), actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(), created_at: text("created_at").notNull(),
}, (table) => ({ workspace: index("accuracy_item_relationship_proposals_workspace_idx").on(table.workspace_id, table.created_at) }));

/** One final contributor decision per proposal. */
export const accuracyItemRelationshipDecisions = pgTable("accuracy_item_relationship_decisions", {
  id: text("id").primaryKey(), workspace_id: text("workspace_id").notNull(),
  proposal_id: text("proposal_id").notNull().references(() => accuracyItemRelationshipProposals.id),
  action: text("action").notNull(), rationale: text("rationale").notNull(),
  actor_name: text("actor_name").notNull(), actor_function: text("actor_function").notNull(),
  created_at: text("created_at").notNull(),
}, (table) => ({ proposal: unique("accuracy_item_relationship_decisions_proposal_key").on(table.proposal_id),
  workspace: index("accuracy_item_relationship_decisions_workspace_idx").on(table.workspace_id, table.proposal_id) }));

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
  source_progress: jsonb("source_progress").$type<SourceProgress>(),
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
  preparation_token: text("preparation_token"),
  preparation_started_at: text("preparation_started_at"),
  prepared_merge: jsonb("prepared_merge"),
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

/** Immutable request and original assembly snapshots; status is derived from the result. */
export const accuracyMixedComparisons = pgTable("accuracy_mixed_comparisons", {
  id: text("id").primaryKey(), source_workspace_id: text("source_workspace_id").notNull(), source_org_id: text("source_org_id").notNull(),
  request: jsonb("request").$type<import("../experiments/mixed-types").MixedComparisonRequest>().notNull(),
  original_assemblies: jsonb("original_assemblies").$type<import("../experiments/mixed-types").MixedOriginalAssemblies>().notNull(),
  pack_fingerprint: text("pack_fingerprint").notNull(), evaluator_version: text("evaluator_version").notNull(),
  gate_policy: text("gate_policy").notNull(), gate_policy_fingerprint: text("gate_policy_fingerprint").notNull(), created_at: text("created_at").notNull(),
}, (table) => ({ workspace: index("accuracy_mixed_comparisons_workspace_idx").on(table.source_workspace_id, table.created_at) }));

/** Both newly created attempts are bound atomically once, before any replay call. */
export const accuracyMixedCandidateLinks = pgTable("accuracy_mixed_candidate_links", {
  comparison_id: text("comparison_id").primaryKey().references(() => accuracyMixedComparisons.id, { onDelete: "cascade" }),
  mixed_experiment_id: text("mixed_experiment_id").notNull().unique().references(() => accuracyExperiments.id),
  baseline_experiment_id: text("baseline_experiment_id").notNull().unique().references(() => accuracyExperiments.id),
  linked_at: text("linked_at").notNull(),
});

/** Exactly one append-only terminal evidence row for each comparison. */
export const accuracyMixedComparisonResults = pgTable("accuracy_mixed_comparison_results", {
  comparison_id: text("comparison_id").primaryKey().references(() => accuracyMixedComparisons.id, { onDelete: "cascade" }),
  evidence: jsonb("evidence").$type<import("../experiments/mixed-types").MixedComparisonResult>().notNull(),
  finished_at: text("finished_at").notNull(),
});

/** Additive bootstrap DDL, safe for new and existing accuracy databases. */
export const ACCURACY_MIXED_COMPARISON_DDL = [
  `CREATE TABLE IF NOT EXISTS accuracy_mixed_comparisons (
    id text PRIMARY KEY, source_workspace_id text NOT NULL, source_org_id text NOT NULL, request jsonb NOT NULL,
    original_assemblies jsonb NOT NULL, pack_fingerprint text NOT NULL, evaluator_version text NOT NULL,
    gate_policy text NOT NULL, gate_policy_fingerprint text NOT NULL, created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_mixed_comparisons_workspace_idx ON accuracy_mixed_comparisons (source_workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_mixed_candidate_links (
    comparison_id text PRIMARY KEY REFERENCES accuracy_mixed_comparisons(id) ON DELETE CASCADE,
    mixed_experiment_id text NOT NULL UNIQUE REFERENCES accuracy_experiments(id),
    baseline_experiment_id text NOT NULL UNIQUE REFERENCES accuracy_experiments(id),
    linked_at text NOT NULL, CHECK (mixed_experiment_id <> baseline_experiment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_mixed_comparison_results (
    comparison_id text PRIMARY KEY REFERENCES accuracy_mixed_comparisons(id) ON DELETE CASCADE,
    evidence jsonb NOT NULL, finished_at text NOT NULL
  )`,
];

export const ACCURACY_DDL = [
  `CREATE TABLE IF NOT EXISTS accuracy_priority_placements (workspace_id text NOT NULL, gap_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(workspace_id,gap_id))`,
  `CREATE TABLE IF NOT EXISTS accuracy_priority_configs (workspace_id text PRIMARY KEY, data jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accuracy_split_operations (
    id text PRIMARY KEY, workspace_id text NOT NULL, operation_key text NOT NULL,
    request_fingerprint text NOT NULL, parent_gap_id text NOT NULL,
    addressed_gap_id text NOT NULL, open_residual_gap_id text NOT NULL,
    state text NOT NULL, snapshot jsonb NOT NULL, audit jsonb NOT NULL,
    created_at text NOT NULL, rolled_back_at text,
    CONSTRAINT accuracy_split_retry_key UNIQUE (workspace_id, operation_key)
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_organizations (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_organization_grants (
    subject text NOT NULL, org_id text NOT NULL,
    UNIQUE (subject, org_id)
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
    evals jsonb,
    evaluation_context text NOT NULL DEFAULT 'production'
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
  `CREATE TABLE IF NOT EXISTS accuracy_item_versions (
    id text PRIMARY KEY, workspace_id text NOT NULL, claim_id text NOT NULL REFERENCES accuracy_claims(id),
    run_id text NOT NULL REFERENCES accuracy_module_runs(id), snapshot_id text REFERENCES accuracy_agent_events(id),
    iteration integer, item_index integer NOT NULL, origin_key text NOT NULL, claim_type text NOT NULL,
    fingerprint text NOT NULL, payload jsonb NOT NULL, source_file_id text NOT NULL REFERENCES accuracy_source_files(id),
    created_at text NOT NULL, CONSTRAINT accuracy_item_versions_origin_key UNIQUE (workspace_id, origin_key)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_item_versions_claim_idx ON accuracy_item_versions (workspace_id, claim_id)`,
  `CREATE INDEX IF NOT EXISTS accuracy_item_versions_exact_idx ON accuracy_item_versions (workspace_id, claim_type, source_file_id, fingerprint)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assemblies (
    id text PRIMARY KEY, workspace_id text NOT NULL, created_at text NOT NULL,
    actor_name text NOT NULL, actor_function text NOT NULL, fingerprint text NOT NULL,
    source_file_ids jsonb NOT NULL, mappings jsonb NOT NULL, coverage jsonb NOT NULL,
    extraction_runs jsonb, linking_complete boolean NOT NULL, output jsonb NOT NULL, checks jsonb NOT NULL,
    generation_key text, CONSTRAINT accuracy_assemblies_workspace_generation_key UNIQUE (workspace_id, generation_key)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assemblies_workspace_idx ON accuracy_assemblies (workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_items (
    id text PRIMARY KEY, workspace_id text NOT NULL, assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    item_version_id text NOT NULL REFERENCES accuracy_item_versions(id), position integer NOT NULL,
    reason text NOT NULL, resolved_item jsonb NOT NULL,
    CONSTRAINT accuracy_assembly_items_position_key UNIQUE (assembly_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assembly_items_workspace_idx ON accuracy_assembly_items (workspace_id, assembly_id)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_reviews (
    id text PRIMARY KEY, workspace_id text NOT NULL, assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    fingerprint text NOT NULL, checks_fingerprint text NOT NULL, decision text NOT NULL,
    rationale text NOT NULL, advisory_overrides jsonb NOT NULL,
    reviewer_subject text NOT NULL, reviewer_provider text NOT NULL,
    reviewer_actor_name text NOT NULL, reviewer_actor_function text NOT NULL, reviewer_role text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assembly_reviews_assembly_idx ON accuracy_assembly_reviews (workspace_id, assembly_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_feedback (
    id text PRIMARY KEY, workspace_id text NOT NULL,
    assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    assembly_fingerprint text NOT NULL,
    approval_review_id text NOT NULL REFERENCES accuracy_assembly_reviews(id),
    consumer_run_id text NOT NULL REFERENCES accuracy_module_runs(id),
    selected_item_version_ids jsonb NOT NULL,
    category text NOT NULL, rationale text NOT NULL,
    actor_subject text NOT NULL, actor_provider text NOT NULL,
    actor_name text NOT NULL, actor_function text NOT NULL, created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assembly_feedback_assembly_idx ON accuracy_assembly_feedback (workspace_id, assembly_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_item_relationship_proposals (
    id text PRIMARY KEY, workspace_id text NOT NULL, kind text NOT NULL, predecessor_ids jsonb NOT NULL,
    successor_ids jsonb NOT NULL, basis_version_ids jsonb NOT NULL, rationale text NOT NULL, actor_name text NOT NULL,
    actor_function text NOT NULL, created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_item_relationship_proposals_workspace_idx ON accuracy_item_relationship_proposals (workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_item_relationship_decisions (
    id text PRIMARY KEY, workspace_id text NOT NULL, proposal_id text NOT NULL REFERENCES accuracy_item_relationship_proposals(id),
    action text NOT NULL, rationale text NOT NULL, actor_name text NOT NULL, actor_function text NOT NULL,
    created_at text NOT NULL, CONSTRAINT accuracy_item_relationship_decisions_proposal_key UNIQUE (proposal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_item_relationship_decisions_workspace_idx ON accuracy_item_relationship_decisions (workspace_id, proposal_id)`,
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
  `CREATE TABLE IF NOT EXISTS accuracy_completeness_verdicts (
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
  )`,
  ...ACCURACY_MIXED_COMPARISON_DDL,
];

/** Reconcile before uniqueness in one locked transaction. Whole historical rows retain all human decisions. */
export const COVERAGE_PAIR_MIGRATION = `DO $$ BEGIN
  LOCK TABLE accuracy_coverage_joins IN SHARE ROW EXCLUSIVE MODE;
  WITH groups AS (
    SELECT workspace_id, gap_id, tactic_id,
      (array_agg(id ORDER BY (validated OR COALESCE((dimensions->>'prior_validated') = 'true', false)
        OR COALESCE(dimensions->'actor' <> 'null'::jsonb, false) OR COALESCE((dimensions->>'human_rejected') = 'true', false)) DESC,
        COALESCE(dimensions->>'decided_at', '') DESC, id ASC))[1] AS survivor,
      jsonb_agg(to_jsonb(accuracy_coverage_joins) ORDER BY id) AS history
    FROM accuracy_coverage_joins GROUP BY workspace_id, gap_id, tactic_id HAVING count(*) > 1
  )
  UPDATE accuracy_coverage_joins AS pair SET dimensions = pair.dimensions ||
    jsonb_build_object('legacy_duplicates', groups.history)
  FROM groups WHERE pair.id = groups.survivor;
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY workspace_id, gap_id, tactic_id
      ORDER BY (validated OR COALESCE((dimensions->>'prior_validated') = 'true', false)
        OR COALESCE(dimensions->'actor' <> 'null'::jsonb, false) OR COALESCE((dimensions->>'human_rejected') = 'true', false)) DESC,
        COALESCE(dimensions->>'decided_at', '') DESC, id ASC) AS position FROM accuracy_coverage_joins
  ) DELETE FROM accuracy_coverage_joins AS pair USING ranked WHERE pair.id = ranked.id AND ranked.position > 1;
  UPDATE accuracy_coverage_joins SET dimensions = dimensions || jsonb_build_object(
      'legacy_rejection', to_jsonb(accuracy_coverage_joins), 'evidence', '[]'::jsonb, 'prior_validated', false),
      overall = 'pending', validated = false
    WHERE dimensions->>'human_rejected' = 'true' AND (overall <> 'pending' OR validated
      OR COALESCE(dimensions->'evidence', '[]'::jsonb) <> '[]'::jsonb);
  UPDATE accuracy_coverage_joins SET overall = CASE lower(trim(overall))
    WHEN 'covers' THEN 'full' WHEN 'none' THEN 'not_relevant' WHEN 'unknown' THEN 'pending'
    WHEN 'full' THEN 'full' WHEN 'partial' THEN 'partial' WHEN 'limited' THEN 'limited'
    WHEN 'not_relevant' THEN 'not_relevant' ELSE 'pending' END;
  CREATE UNIQUE INDEX IF NOT EXISTS accuracy_coverage_pair_key
    ON accuracy_coverage_joins (workspace_id, gap_id, tactic_id);
END $$`;

/** Additive ALTERs for already-created tables. Safe to re-run. */
export const ACCURACY_MIGRATIONS = [
  `ALTER TABLE accuracy_item_relationship_proposals ADD COLUMN IF NOT EXISTS basis_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE accuracy_module_runs ADD COLUMN IF NOT EXISTS evaluation_context text NOT NULL DEFAULT 'production'`,
  `ALTER TABLE accuracy_experiments ADD COLUMN IF NOT EXISTS source_org_id text`,
  `UPDATE accuracy_experiments AS experiment
   SET source_org_id = workspace.org_id
   FROM accuracy_workspaces AS workspace
   WHERE experiment.source_org_id IS NULL
     AND experiment.source_workspace_id = workspace.id`,
  `UPDATE accuracy_experiments
   SET source_org_id = 'unknown_deleted_source_org_v1'
   WHERE source_org_id IS NULL`,
  `ALTER TABLE accuracy_experiments ALTER COLUMN source_org_id SET NOT NULL`,
  `ALTER TABLE accuracy_omission_actions ADD COLUMN IF NOT EXISTS contributor_statement text`,
  `ALTER TABLE accuracy_workspaces ADD COLUMN IF NOT EXISTS archived_at text`,
  `CREATE TABLE IF NOT EXISTS accuracy_assemblies (
    id text PRIMARY KEY, workspace_id text NOT NULL, created_at text NOT NULL,
    actor_name text NOT NULL, actor_function text NOT NULL, fingerprint text NOT NULL,
    source_file_ids jsonb NOT NULL, mappings jsonb NOT NULL, coverage jsonb NOT NULL,
    extraction_runs jsonb, linking_complete boolean NOT NULL, output jsonb NOT NULL, checks jsonb NOT NULL,
    generation_key text, CONSTRAINT accuracy_assemblies_workspace_generation_key UNIQUE (workspace_id, generation_key)
  )`,
  `ALTER TABLE accuracy_assemblies ADD COLUMN IF NOT EXISTS extraction_runs jsonb`,
  `CREATE INDEX IF NOT EXISTS accuracy_assemblies_workspace_idx ON accuracy_assemblies (workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_items (
    id text PRIMARY KEY, workspace_id text NOT NULL, assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    item_version_id text NOT NULL REFERENCES accuracy_item_versions(id), position integer NOT NULL,
    reason text NOT NULL, resolved_item jsonb NOT NULL,
    CONSTRAINT accuracy_assembly_items_position_key UNIQUE (assembly_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assembly_items_workspace_idx ON accuracy_assembly_items (workspace_id, assembly_id)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_reviews (
    id text PRIMARY KEY, workspace_id text NOT NULL, assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    fingerprint text NOT NULL, checks_fingerprint text NOT NULL, decision text NOT NULL,
    rationale text NOT NULL, advisory_overrides jsonb NOT NULL,
    reviewer_subject text NOT NULL, reviewer_provider text NOT NULL,
    reviewer_actor_name text NOT NULL, reviewer_actor_function text NOT NULL, reviewer_role text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assembly_reviews_assembly_idx ON accuracy_assembly_reviews (workspace_id, assembly_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_feedback (
    id text PRIMARY KEY, workspace_id text NOT NULL,
    assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    assembly_fingerprint text NOT NULL,
    approval_review_id text NOT NULL REFERENCES accuracy_assembly_reviews(id),
    consumer_run_id text NOT NULL REFERENCES accuracy_module_runs(id),
    selected_item_version_ids jsonb NOT NULL,
    category text NOT NULL, rationale text NOT NULL,
    actor_subject text NOT NULL, actor_provider text NOT NULL,
    actor_name text NOT NULL, actor_function text NOT NULL, created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS accuracy_assembly_feedback_assembly_idx ON accuracy_assembly_feedback (workspace_id, assembly_id, created_at)`,
  `ALTER TABLE accuracy_item_versions ALTER COLUMN run_id DROP NOT NULL`,
  `ALTER TABLE accuracy_item_versions ADD COLUMN IF NOT EXISTS human_origin jsonb`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_revisions (
    id text PRIMARY KEY, workspace_id text NOT NULL,
    baseline_assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    parent_assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    initial_assembly_id text NOT NULL REFERENCES accuracy_assemblies(id), change jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_revision_heads (
    baseline_assembly_id text PRIMARY KEY REFERENCES accuracy_assemblies(id), workspace_id text NOT NULL,
    assembly_id text NOT NULL REFERENCES accuracy_assemblies(id),
    revision_id text NOT NULL REFERENCES accuracy_assembly_revisions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_assembly_revision_attempts (
    id text PRIMARY KEY, workspace_id text NOT NULL,
    revision_id text NOT NULL REFERENCES accuracy_assembly_revisions(id),
    assembly_id text NOT NULL REFERENCES accuracy_assemblies(id), error text, created_at text NOT NULL
  )`,
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
  `ALTER TABLE accuracy_resume_journals ADD COLUMN IF NOT EXISTS preparation_token text`,
  `ALTER TABLE accuracy_resume_journals ADD COLUMN IF NOT EXISTS preparation_started_at text`,
  `ALTER TABLE accuracy_resume_journals ADD COLUMN IF NOT EXISTS prepared_merge jsonb`,
  `ALTER TABLE accuracy_extraction_batches ADD COLUMN IF NOT EXISTS source_progress jsonb`,
  COVERAGE_PAIR_MIGRATION,
];
