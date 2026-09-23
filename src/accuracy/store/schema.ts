import { boolean, integer, jsonb, numeric, pgTable, text, unique } from "drizzle-orm/pg-core";

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
    created_at text NOT NULL
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
];
