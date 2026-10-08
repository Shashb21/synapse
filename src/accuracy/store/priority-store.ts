/** Accuracy's workspace-scoped S8 adapter. Providers never run under its mutation lock. */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadAxesConfiguration, parseAxesConfig, validateAxes, type StoredAxes, type ScopeAxes } from "@/modules/stages/s8-prioritization/axes";
import { placementFromScores, manualPriorityInput, type WorkingPriority, type PriorityConsiderations, type PlanningContext } from "@/modules/stages/s8-prioritization/scoring";
import type { MatrixBand } from "@/modules/stages/s8-prioritization/axis-math";
import { runInWorkspace } from "@/modules/workspaces/context";
import { enteredAssetDetails } from "@/lib/iegp/asset";
import { nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import { claimFactualRevision, claimValidationFreshness, readStructuredFields, structuredProvenance } from "@/accuracy/domain/structured-fields";
import { deriveGapStatus, asTacticLifecycle } from "@/accuracy/modules/status-derive/engine";
import { accuracyDb, accuracyTransactionActive, ensureAccuracySchema, withAccuracyWorkspaceMutation } from "./db";
import * as t from "./schema";
import { claimMetadata, getClaim, updateClaimMetadata, listDownstreamClaims, isActiveLedgerClaim, requireClaimActor, requireValidationRationale } from "./claim-store";
import { listCoverageJoins } from "./coverage-store";
import { getWorkspace } from "./tenant";
import { readParseBlocksByIds } from "./parse-store";
import { provenanceSpanSchema, validateProvenance, validateQuoteAgainstBlock, type ProvenanceSpan, type ParseBlock } from "./quote-validator";
import { invalidateAccuracyPriorityValidation } from "./priority-records";
import { withHumanEdit } from "./claim-edit";

export function priorityRevision(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export class PriorityError extends Error {
  constructor(readonly code: "unknown_workspace" | "unknown_gap" | "ineligible_gap" | "invalid_placement" | "invalid_config" | "stale_revision", message: string) {
    super(message); this.name = "PriorityError";
  }
}
export const PRIORITY_CONSIDERATIONS = ["strategic_fit", "clinical_patient_impact", "payer_relevance", "guideline_evidence", "unmet_need", "competitive_differentiation", "feasibility"] as const;
export const priorityContextSchema = z.object({
  key_decision: z.string().optional(), decision_date: z.string().optional(), competitor_pressure: z.string().optional(),
  launch_timeline: z.string().optional(), company_situation: z.string().optional(), lifecycle_stage: z.string().optional(),
  strategic_importance: z.number().min(1).max(5).optional(),
});
export const priorityConsiderationsSchema = z.partialRecord(z.enum(PRIORITY_CONSIDERATIONS), z.object({ text: z.string(), references: z.array(provenanceSpanSchema) }).strict());
export type PrioritySelection = { setting?: string; x_axis?: string; y_axis?: string; context?: PlanningContext };
export type AccuracyPriorityConfig = { catalog: StoredAxes; scopes: Record<string, ScopeAxes>; revision: string; history?: Record<string, unknown>[]; updated_at?: string };
export type PriorityValidation = { freshness: "current" | "stale" | "unvalidated"; input_revision: string; config_revision: string;
  by: string; by_function: string; rationale: string; at: string };
export type AccuracyPlacement = WorkingPriority & {
  workspace_id: string; gap_id: string; selection: PrioritySelection;
  input_revision: string; config_revision: string; score: number | null;
  validation: PriorityValidation | null; references: ProvenanceSpan[]; limitations: string[];
  history: Record<string, unknown>[]; human_revision: string | null;
};
const matrixBandSchema = z.enum(["high", "medium", "low", "defer"]);
export const accuracyPlacementSchema = z.object({
  workspace_id: z.string(), gap_id: z.string(), axis_scores: z.record(z.string(), z.number().min(0).max(100)),
  suggested_band: matrixBandSchema, suggested_rationale: z.string(), band: matrixBandSchema.nullable(), validated: z.boolean(),
  rationale: z.string().nullable(), actor_name: z.string().nullable(), actor_function: z.string().nullable().optional(), at: z.string(),
  human_axes: z.array(z.string()).optional(), human_band: z.boolean().optional(),
  selection: z.object({ setting: z.string().optional(), x_axis: z.string().optional(), y_axis: z.string().optional(), context: priorityContextSchema.optional() }),
  input_revision: z.string(), config_revision: z.string(), score: z.number().min(0).max(100).nullable(),
  validation: z.object({ freshness: z.enum(["current", "stale", "unvalidated"]), input_revision: z.string(), config_revision: z.string(), by: z.string(), by_function: z.string(), rationale: z.string(), at: z.string() }).nullable(),
  references: z.array(provenanceSpanSchema), limitations: z.array(z.string()), history: z.array(z.record(z.string(), z.unknown())), human_revision: z.string().nullable(),
});
const scopeKey = (setting?: string) => setting?.trim().toLowerCase() || "all";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** First use explicitly inherits the Default S8 catalog and every saved scope, never a request's unrelated plan cookie.
 * The optional setting argument remains compatible with existing callers; it does not limit inheritance.
 * Thereafter the saved copy and every edit belong solely to this Accuracy workspace. */
export async function loadAccuracyPriorityConfig(workspace_id: string, _setting?: string): Promise<AccuracyPriorityConfig> {
  void _setting;
  await ensureAccuracySchema();
  if (!await getWorkspace(workspace_id)) throw new PriorityError("unknown_workspace", "Unknown workspace.");
  const [row] = await accuracyDb().select().from(t.accuracyPriorityConfigs).where(eq(t.accuracyPriorityConfigs.workspace_id, workspace_id));
  if (row) return row.data as AccuracyPriorityConfig;
  if (accuracyTransactionActive()) throw new PriorityError("invalid_config", "Initialize priority configuration before starting an Accuracy transaction.");
  const seed = await runInWorkspace({ workspace_id: "default", schema: "public" }, async () => {
    const { catalog, scopes } = await loadAxesConfiguration();
    return { catalog, scopes, revision: priorityRevision({ catalog, scopes }) };
  });
  return withAccuracyWorkspaceMutation(workspace_id, async () => {
    if (!await getWorkspace(workspace_id)) throw new PriorityError("unknown_workspace", "Unknown workspace.");
    await accuracyDb().insert(t.accuracyPriorityConfigs).values({ workspace_id, data: seed }).onConflictDoNothing();
    const [saved] = await accuracyDb().select().from(t.accuracyPriorityConfigs).where(eq(t.accuracyPriorityConfigs.workspace_id, workspace_id));
    return saved.data as AccuracyPriorityConfig;
  });
}
export async function saveAccuracyPriorityConfig(args: { workspace_id: string; config?: unknown; scope?: string; x_axis?: string; y_axis?: string; actor: Actor; rationale: string; expected_config_revision?: string; context?: PlanningContext; considerations?: z.infer<typeof priorityConsiderationsSchema> }) {
  requireClaimActor(args.actor); requireValidationRationale(args.rationale);
  await loadAccuracyPriorityConfig(args.workspace_id, args.scope);
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const [row] = await accuracyDb().select().from(t.accuracyPriorityConfigs).where(eq(t.accuracyPriorityConfigs.workspace_id, args.workspace_id));
    if (!row) throw new PriorityError("unknown_workspace", "Unknown priority workspace.");
    const before = row.data as AccuracyPriorityConfig;
    if (args.expected_config_revision && before.revision !== args.expected_config_revision) throw new PriorityError("stale_revision", "Priority configuration changed; reload before saving.");
    let catalog = before.catalog;
    try { if (args.config !== undefined) catalog = { ...validateAxes(parseAxesConfig(args.config)), updated_at: nowIso(), updated_by: args.actor.name }; }
    catch (error) { throw new PriorityError("invalid_config", (error as Error).message); }
    const scopes = Object.fromEntries(Object.entries(before.scopes).filter(([, pair]) => catalog.axes.some(a => a.id === pair.x_axis) && catalog.axes.some(a => a.id === pair.y_axis)));

    if (args.scope !== undefined) {
      if (!catalog.axes.some(a => a.id === args.x_axis) || !catalog.axes.some(a => a.id === args.y_axis) || args.x_axis === args.y_axis)
        throw new PriorityError("invalid_config", "Pick two different configured axes for the matrix.");
      scopes[scopeKey(args.scope)] = { x_axis: args.x_axis!, y_axis: args.y_axis!, updated_by: args.actor.name, updated_at: nowIso() };
    }
    if (args.config === undefined && args.scope === undefined && args.context === undefined && args.considerations === undefined) throw new PriorityError("invalid_config", "Give a catalog, scope pair or planning context.");
    const workspace = (await getWorkspace(args.workspace_id))!, planning = record(workspace.planning_context);
    const context = args.context === undefined ? undefined : priorityContextSchema.parse(args.context);
    const considerations = args.considerations === undefined ? undefined : priorityConsiderationsSchema.parse(args.considerations);
    for (const item of Object.values(considerations ?? {})) {
      if (item && !(await verifiedReferences(args.workspace_id, item.references)).valid) throw new PriorityError("invalid_config", "Planning context references must match live workspace source evidence.");
    }
    const planning_context = { ...planning, ...context, ...(considerations ? { priority_considerations: { ...record(planning.priority_considerations), ...considerations } } : {}) };
    if (context || considerations) await accuracyDb().update(t.accuracyWorkspaces).set({ planning_context }).where(eq(t.accuracyWorkspaces.id, args.workspace_id));
    const updated_at = nowIso();
    const audit = withHumanEdit({}, { action: "edit", fields: ["priority_configuration"], before: { catalog: before.catalog, scopes: before.scopes, planning_context: planning },
      after: { catalog, scopes, planning_context }, actor: args.actor, rationale: args.rationale.trim(), at: updated_at });
    const data: AccuracyPriorityConfig = { catalog, scopes, updated_at, revision: priorityRevision({ catalog, scopes, updated_at }),
      history: [...(before.history ?? []), ...(audit.edit_history ?? [])] as unknown as Record<string, unknown>[] };
    await accuracyDb().update(t.accuracyPriorityConfigs).set({ data }).where(eq(t.accuracyPriorityConfigs.workspace_id, args.workspace_id));
    await invalidateAccuracyPriorityValidation(args.workspace_id, null, nowIso(), "priority_configuration_changed");
    return data;
  });
}
export function resolveAccuracyPriorityAxes(config: AccuracyPriorityConfig, selection: PrioritySelection) {
  const { catalog } = config, scope = config.scopes[scopeKey(selection.setting)];
  if (Boolean(selection.x_axis) !== Boolean(selection.y_axis)) throw new PriorityError("invalid_config", "Pick both matrix axes.");
  const xAxis = catalog.axes.find(a => a.id === (selection.x_axis ?? scope?.x_axis ?? catalog.x_axis));
  const yAxis = catalog.axes.find(a => a.id === (selection.y_axis ?? scope?.y_axis ?? catalog.y_axis));
  if (!xAxis || !yAxis || xAxis.id === yAxis.id) throw new PriorityError("invalid_config", "Pick two different configured axes for the matrix.");
  const pairOnly = Boolean(selection.x_axis && selection.y_axis) || Boolean(scope);
  return { xAxis, yAxis, axes: pairOnly ? [xAxis, yAxis] : catalog.axes, pairChosen: pairOnly || catalog.updated_by !== "default" };
}
export async function readStoredAccuracyPlacements(workspace_id: string): Promise<AccuracyPlacement[]> {
  await ensureAccuracySchema();
  return (await accuracyDb().select().from(t.accuracyPriorityPlacements).where(eq(t.accuracyPriorityPlacements.workspace_id, workspace_id)))
    .map(row => row.data as AccuracyPlacement).sort((a, b) => a.gap_id.localeCompare(b.gap_id));
}
export async function writeAccuracyPlacement(row: AccuracyPlacement) {
  if (!accuracyTransactionActive()) throw new Error("Priority persistence requires an Accuracy transaction.");
  accuracyPlacementSchema.parse(row);
  await accuracyDb().insert(t.accuracyPriorityPlacements).values({ workspace_id: row.workspace_id, gap_id: row.gap_id, data: row })
    .onConflictDoUpdate({ target: [t.accuracyPriorityPlacements.workspace_id, t.accuracyPriorityPlacements.gap_id], set: { data: row } });
}
async function verifiedReferences(workspace_id: string, raw: unknown): Promise<{ references: ProvenanceSpan[]; valid: boolean; facts: unknown }> {
  const parsed = provenanceSpanSchema.array().safeParse(raw);
  if (!parsed.success) return { references: [], valid: false, facts: raw };
  if (!parsed.data.length) return { references: [], valid: true, facts: { spans: [], blocks: [], sources: [] } };
  const blocks = await readParseBlocksByIds(workspace_id, [...new Set(parsed.data.map(s => s.block_id))]);
  const sources = await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, workspace_id));
  const references = parsed.data.filter(span => {
    const block = blocks.find(b => b.id === span.block_id);
    return sources.some(s => s.id === span.source_file_id) && block && validateProvenance({ span, block: block as ParseBlock }).ok;
  });
  return { references, valid: references.length === parsed.data.length,
    facts: { spans: parsed.data, blocks: blocks.map(b => ({ id: b.id, source_file_id: b.source_file_id, text: b.text })), sources: parsed.data.map(s => sources.find(source => source.id === s.source_file_id) ?? null) } };
}
/** Read inside the common lock for a consistent eligibility/token snapshot. No model here. */
export async function priorityInputs(workspace_id: string, gap_id: string, selection: PrioritySelection = {}) {
  const gap = (await listDownstreamClaims(workspace_id, { limit: null })).find(row => row.id === gap_id);
  if (!gap || gap.claim_type !== "gap") {
    const raw = await getClaim(workspace_id, gap_id);
    if (raw?.claim_type === "gap" && !isActiveLedgerClaim(raw)) throw new PriorityError("ineligible_gap", "inactive");
    throw new PriorityError("unknown_gap", "Unknown gap in workspace.");
  }
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new PriorityError("unknown_workspace", "Unknown workspace.");
  const [configRow] = await accuracyDb().select().from(t.accuracyPriorityConfigs).where(eq(t.accuracyPriorityConfigs.workspace_id, workspace_id));
  if (!configRow) throw new PriorityError("unknown_workspace", "Priority workspace configuration is unavailable.");
  const config = configRow.data as AccuracyPriorityConfig;
  const resolved = resolveAccuracyPriorityAxes(config, selection);
  const claims = await listDownstreamClaims(workspace_id, { limit: null });
  const tactics = claims.filter(c => c.claim_type === "tactic" && isActiveLedgerClaim(c)).sort((a, b) => a.id.localeCompare(b.id));
  const coverage = (await listCoverageJoins(workspace_id, { effective: true })).filter(c => c.gap_id === gap_id).sort((a, b) => a.tactic_id.localeCompare(b.tactic_id));
  const computed = deriveGapStatus({ gap_id, coverages: coverage,
    tactics: tactics.map(c => ({ id: c.id, status: asTacticLifecycle(claimMetadata(c).tactic_status) ?? asTacticLifecycle(c.status) ?? "unknown" })) });
  const meta = claimMetadata(gap), override = meta.status_override;
  const structured = readStructuredFields(gap);
  const evidence = await verifiedReferences(workspace_id, [...(Array.isArray(meta.provenance) ? meta.provenance : []), ...structuredProvenance(structured),
    ...(Array.isArray(meta.inherited_context) ? meta.inherited_context : [])]);
  const validation = meta.validation;
  const humanValidated = claimValidationFreshness(gap) === "current" && validation?.action === "validate"
    && typeof validation.by === "string" && Boolean(validation.by.trim()) && typeof validation.by_function === "string" && Boolean(validation.by_function.trim())
    && typeof validation.rationale === "string" && validation.rationale.trim().length >= 3;
  let reason: string | null = !isActiveLedgerClaim(gap) ? "inactive" : !humanValidated ? "claim_validation_not_current"
    : computed !== "open" ? `computed_${computed}` : override?.stale ? "stale_status_override"
    : override && override.status !== "open" ? `status_override_${override.status}` : !evidence.valid ? "unsupported_evidence" : null;
  const setting = scopeKey(selection.setting), sf = "disease_setting" in structured ? structured.disease_setting : undefined;
  const settings = Array.isArray(meta.settings) ? meta.settings.map(String) : [];
  if (sf?.state === "known") settings.push(String(sf.value));
  if (!reason && setting !== "all" && !settings.some(s => s.trim().toLowerCase() === setting)) reason = "outside_setting";
  const planning = record(workspace.planning_context), context = { ...priorityContextSchema.parse(Object.fromEntries(Object.entries(planning).filter(([k]) => k in priorityContextSchema.shape))), ...selection.context };
  const considerations: PriorityConsiderations = {}, contextFacts: unknown[] = [];
  const rawConsiderations = record(planning.priority_considerations);
  for (const key of PRIORITY_CONSIDERATIONS) {
    const item = record(rawConsiderations[key]);
    const refs = await verifiedReferences(workspace_id, item.references ?? []);
    const supported = typeof item.text === "string" && Boolean(item.text.trim()) && refs.valid
      && refs.references.some(ref => validateQuoteAgainstBlock({ block: { text: ref.quote }, quote: String(item.text) }).ok);
    considerations[key] = { state: supported ? "supported" : "missing", text: supported ? String(item.text) : "No verified source-backed context supplied.", references: supported ? refs.references : [] };
    contextFacts.push({ key, item, facts: refs.facts });
  }
  const references = [...new Map([...evidence.references, ...Object.values(considerations).flatMap(c => c.references)].map(s => [priorityRevision(s), s])).values()];
  const asset = enteredAssetDetails(Object.fromEntries(Object.entries(record(planning.asset)).filter(([key, value]) => ["name", "inn", "indication", "geography"].includes(key) && typeof value === "string")));
  const input_revision = priorityRevision({ workspace_id, gap_id, factual_revision: claimFactualRevision(gap), active: isActiveLedgerClaim(gap), claim_validation: claimValidationFreshness(gap),
    override, computed, coverage: coverage.map(c => ({ tactic_id: c.tactic_id, overall: c.overall, validated: c.validated, freshness: c.freshness, dimensions: c.dimensions })),
    tactics: tactics.filter(t => coverage.some(c => c.tactic_id === t.id)).map(t => ({ id: t.id, revision: claimFactualRevision(t) })), evidence: evidence.facts, asset, context, contextFacts, setting, settings });
  return { gap, config, ...resolved, context, considerations, references, asset,
    limitations: [...Object.entries(considerations).filter(([, c]) => c.state === "missing").map(([key]) => `Missing context: ${key}`), ...(evidence.references.length ? [] : ["Missing gap evidence: no verified source references"])],
    input_revision, config_revision: priorityRevision({ revision: config.revision, x_axis: resolved.xAxis.id, y_axis: resolved.yAxis.id, pairChosen: resolved.pairChosen }), reason };
}
export function effectiveAccuracyPlacement(row: AccuracyPlacement, inputs: Pick<Awaited<ReturnType<typeof priorityInputs>>, "input_revision" | "config_revision" | "reason">): AccuracyPlacement {
  const current = row.validated && row.validation && row.validation.freshness !== "stale" && !inputs.reason && row.validation.input_revision === inputs.input_revision && row.validation.config_revision === inputs.config_revision;
  return { ...row, validated: Boolean(row.validated && current), validation: row.validation ? { ...row.validation, freshness: current ? "current" : "stale" } : null };
}
/** Stale decisions remain readable when their former axes or gap are no longer available. */
export async function readEffectiveAccuracyPlacement(row: AccuracyPlacement) {
  try {
    const inputs = await priorityInputs(row.workspace_id, row.gap_id, row.selection);
    return { placement: effectiveAccuracyPlacement(row, inputs), inputs };
  } catch (error) {
    if (!(error instanceof PriorityError) || !["invalid_config", "unknown_gap"].includes(error.code)) throw error;
    return { placement: { ...effectiveAccuracyPlacement(row, { input_revision: "", config_revision: "", reason: error.code }),
      limitations: [...row.limitations, "Working placement inputs are unavailable; select current axes and review."] }, inputs: null };
  }
}
export async function listAccuracyPlacements(workspace_id: string): Promise<AccuracyPlacement[]> {
  await loadAccuracyPriorityConfig(workspace_id);
  return withAccuracyWorkspaceMutation(workspace_id, async () => {
    const rows = await readStoredAccuracyPlacements(workspace_id);
    return Promise.all(rows.map(async row => (await readEffectiveAccuracyPlacement(row)).placement));
  });
}
export async function readAccuracyPriorityInputs(args: { workspace_id: string; gap_id: string } & PrioritySelection) {
  await loadAccuracyPriorityConfig(args.workspace_id, args.setting);
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const prior = (await readStoredAccuracyPlacements(args.workspace_id)).find(row => row.gap_id === args.gap_id);
    const selection = { ...prior?.selection, ...Object.fromEntries(Object.entries(args).filter(([k, v]) => ["x_axis", "y_axis", "setting", "context"].includes(k) && v !== undefined)) };
    return priorityInputs(args.workspace_id, args.gap_id, selection);
  });
}
export async function setAccuracyPlacement(args: { workspace_id: string; gap_id: string; axis_scores?: Record<string, number>; band?: MatrixBand;
  validate?: boolean; rationale: string; actor: Actor; expected_input_revision?: string; expected_config_revision?: string } & PrioritySelection): Promise<AccuracyPlacement> {
  requireClaimActor(args.actor); const rationale = requireValidationRationale(args.rationale);
  await loadAccuracyPriorityConfig(args.workspace_id, args.setting);
  return withAccuracyWorkspaceMutation(args.workspace_id, async () => {
    const stored = (await readStoredAccuracyPlacements(args.workspace_id)).find(r => r.gap_id === args.gap_id);
    const selection = { ...stored?.selection, ...Object.fromEntries(Object.entries(args).filter(([k, v]) => ["x_axis", "y_axis", "setting", "context"].includes(k) && v !== undefined)) };
    const state = await priorityInputs(args.workspace_id, args.gap_id, selection);
    if (state.reason) throw new PriorityError("ineligible_gap", `Gap is not eligible for priority: ${state.reason}.`);
    if ((args.expected_input_revision && args.expected_input_revision !== state.input_revision) || (args.expected_config_revision && args.expected_config_revision !== state.config_revision))
      throw new PriorityError("stale_revision", "Priority inputs changed; reload before saving.");
    const current = stored ? effectiveAccuracyPlacement(stored, state) : null;
    let working;
    try { working = manualPriorityInput({ ...args, x_axis: state.xAxis.id, y_axis: state.yAxis.id, axes: state.config.catalog.axes }, current); }
    catch (error) { throw new PriorityError("invalid_placement", (error as Error).message); }
    const at = nowIso();
    const audit = withHumanEdit({}, {
      action: "edit", fields: ["priority_placement"], before: { band: current?.band ?? null, axis_scores: current?.axis_scores ?? {} },
      after: { band: working.band, axis_scores: working.axis_scores, validated: working.validated }, actor: args.actor, rationale, at });
    const row: AccuracyPlacement = { workspace_id: args.workspace_id, gap_id: args.gap_id, selection,
      ...working, suggested_band: current?.suggested_band ?? working.band, suggested_rationale: current?.suggested_rationale ?? "",
      rationale, actor_name: args.actor.name, actor_function: args.actor.function, at, input_revision: state.input_revision, config_revision: state.config_revision,
      score: [state.xAxis, state.yAxis].every(a => typeof working.axis_scores[a.id] === "number") ? placementFromScores(state.xAxis, state.yAxis, working.axis_scores).score : null, references: state.references, limitations: state.limitations,
      validation: working.validated ? { freshness: "current", input_revision: state.input_revision, config_revision: state.config_revision, by: args.actor.name, by_function: args.actor.function, rationale, at } : current?.validation ? { ...current.validation, freshness: "stale" } : null,
      history: [...(stored?.history ?? []), ...(audit.edit_history ?? [])] as unknown as Record<string, unknown>[], human_revision: priorityRevision({ prior: stored?.human_revision, at, actor: args.actor, working, rationale }) };
    await writeAccuracyPlacement(row);
    if (row.band) await updateClaimMetadata({ workspace_id: args.workspace_id, claim_id: args.gap_id, merge: true,
      metadata: { priority: row.band, priority_band: row.band, priority_origin: "review", priority_rationale: rationale } });
    return row;
  });
}
export async function validateAccuracyPlacement(args: Parameters<typeof setAccuracyPlacement>[0] & { band: MatrixBand }) {
  return setAccuracyPlacement({ ...args, validate: true });
}
