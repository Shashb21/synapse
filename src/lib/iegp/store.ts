import { and, eq } from "drizzle-orm";
import { db, ensureSchema, wipeIegp } from "./db";
import * as t from "./schema";
import { buildBlankWorkspace } from "./blank";
import { buildSeed } from "./seed";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import type { PlanningContext } from "./planning-context";
import { parsePlanningContext } from "./planning-context";
import type { IegpState, Lock, GapStatusOverride } from "./types";
import type { ExtractedGap, ExtractedTactic } from "./engine";
import type {
  ActorFunction,
  CatchUpReason,
  CatchUpTacticStatus,
  CoverageDimension,
  DimensionValue,
  EvidenceDomain,
  MappedGapStatus,
  OverallCoverage,
} from "./enums";
import {
  ASSESSED_COVERAGE,
  CATCH_UP_REASON_LABELS,
  CATCH_UP_REASONS,
  CATCH_UP_TACTIC_STATUSES,
  COVERAGE_DIMENSIONS,
  DIMENSION_VALUES,
  EVIDENCE_DOMAINS,
  OVERALL_COVERAGE,
  TACTIC_TYPES,
} from "./enums";
import {
  computeGapStatus,
  displayedGapStatus,
  emptyDimensions,
  gapEligibleForMapping,
  gapNameFromStatement,
  gapsReadyForPrioritize,
  isLiveGap,
  persistedResidualGaps,
  requireOverrideReason,
  splitSourceIntoBlocks,
  tacticEligibleForMapping,
  unlocked,
} from "./engine";

function asStatusOverride(value: unknown): GapStatusOverride | null {
  if (!value || typeof value !== "object") return null;
  const v = value as GapStatusOverride;
  if (!v.status || !v.reason || !v.actor_name || !v.from || !v.to) return null;
  return {
    status: v.status,
    from: v.from,
    to: v.to,
    reason: v.reason,
    actor_name: v.actor_name,
    actor_function: v.actor_function,
    at: v.at,
    stale: Boolean(v.stale),
  };
}

function asLock(value: unknown): Lock {
  const v = value as Lock;
  return {
    locked: Boolean(v?.locked),
    actor_name: v?.actor_name ?? null,
    actor_function: v?.actor_function ?? null,
    locked_at: v?.locked_at ?? null,
    note: v?.note ?? null,
  };
}

/**
 * Settings are free tags, so the same setting typed twice ("1L", " 1l ") must
 * collapse to one. The first spelling wins; order is kept.
 */
export function normalizeSettings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

export async function loadState(): Promise<IegpState> {
  await ensureSchema();
  const d = db();
  const assetRows = await d.select().from(t.assets);
  if (assetRows.length === 0) {
    await persistState(buildBlankWorkspace());
  }
  return readState();
}

async function readState(): Promise<IegpState> {
  const d = db();
  const [
    assetRows,
    objectives,
    sources,
    blocks,
    needs,
    gaps,
    need_gap_links,
    tactics,
    coverages,
    mapping_suggestions,
    residual_gap_suggestions,
    residuals,
    priorities,
    roadmap,
    audit,
    gold_needs,
    gold_coverages,
    gap_versions,
    breakout_groups,
    breakout_group_gaps,
  ] = await Promise.all([
    d.select().from(t.assets),
    d.select().from(t.objectives),
    d.select().from(t.sources),
    d.select().from(t.sourceBlocks),
    d.select().from(t.needs),
    d.select().from(t.gaps),
    d.select().from(t.needGapLinks),
    d.select().from(t.tactics),
    d.select().from(t.coverages),
    d.select().from(t.mappingSuggestions),
    d.select().from(t.residualGapSuggestions),
    d.select().from(t.residuals),
    d.select().from(t.priorities),
    d.select().from(t.roadmap),
    d.select().from(t.audit),
    d.select().from(t.goldNeeds),
    d.select().from(t.goldCoverages),
    d.select().from(t.gapVersions),
    d.select().from(t.breakoutGroups),
    d.select().from(t.breakoutGroupGaps),
  ]);
  const asset = assetRows[0]!;
  return {
    asset: {
      ...asset,
      wizard_complete: Boolean(asset.wizard_complete),
      tactics_unlocked: Boolean(asset.tactics_unlocked),
      setup_complete: Boolean(asset.setup_complete),
      planning_context: asset.planning_context ?? {},
    },
    objectives,
    sources: sources.map((s) => ({
      ...s,
      source_type: s.source_type as IegpState["sources"][0]["source_type"],
      stakeholder_function: s.stakeholder_function as ActorFunction,
    })),
    blocks,
    needs: needs.map((n) => ({
      ...n,
      domain: n.domain as IegpState["needs"][0]["domain"],
      stakeholder: n.stakeholder as ActorFunction,
      status: n.status as IegpState["needs"][0]["status"],
      status_lock: asLock(n.lock),
    })),
    gaps: gaps.map((g) => ({
      ...g,
      domain: g.domain as IegpState["gaps"][0]["domain"],
      status: g.status as IegpState["gaps"][0]["status"],
      exclusion_reason: g.exclusion_reason as IegpState["gaps"][0]["exclusion_reason"],
      status_lock: asLock(g.lock),
      parent_gap_id: g.parent_gap_id ?? null,
      computed_status: (g.computed_status as IegpState["gaps"][0]["computed_status"]) ?? null,
      status_override: asStatusOverride(g.status_override),
      retired: Boolean(g.retired),
      human_validated: Boolean(g.human_validated),
      parked_at: g.parked_at ?? null,
      parked_reason: g.parked_reason ?? null,
      settings: normalizeSettings(g.settings),
    })),
    need_gap_links: need_gap_links.map((l) => ({
      ...l,
      role: l.role as "primary" | "supporting",
    })),
    tactics: tactics.map((x) => ({
      ...x,
      type: x.type as IegpState["tactics"][0]["type"],
      status: x.status as IegpState["tactics"][0]["status"],
      review_status: (x.review_status as IegpState["tactics"][0]["review_status"]) || "accepted",
      function: x.function as ActorFunction,
      lock: asLock(x.lock),
    })),
    coverages: coverages.map((c) => ({
      ...c,
      dimensions: c.dimensions as IegpState["coverages"][0]["dimensions"],
      overall: c.overall as IegpState["coverages"][0]["overall"],
      overall_lock: asLock(c.overall_lock),
      stale: Boolean(c.stale),
      needs_review: Boolean(c.needs_review),
    })),
    mapping_suggestions: mapping_suggestions.map((m) => ({
      gap_id: m.gap_id,
      tactic_id: m.tactic_id,
      status: m.status as IegpState["mapping_suggestions"][0]["status"],
      lock: asLock(m.lock),
    })),
    residual_gap_suggestions: residual_gap_suggestions.map((m) => ({
      parent_gap_id: m.parent_gap_id,
      statement: m.statement,
      reasons: m.reasons as string[],
      status: m.status as IegpState["residual_gap_suggestions"][0]["status"],
      lock: asLock(m.lock),
    })),
    residuals: residuals.map((r) => ({
      ...r,
      domain: r.domain as IegpState["residuals"][0]["domain"],
      review_status: (r.review_status as IegpState["residuals"][0]["review_status"]) || "candidate",
      created_gap_id: r.created_gap_id ?? null,
      lock: asLock(r.lock),
    })),
    priorities: priorities.map((p) => ({
      ...p,
      suggested_band: p.suggested_band as IegpState["priorities"][0]["suggested_band"],
      band: p.band as IegpState["priorities"][0]["band"],
      reasons: p.reasons as string[],
      lock: asLock(p.lock),
    })),
    roadmap: roadmap.map((r) => ({
      ...r,
      residual_ids: r.residual_ids as string[],
      lock: asLock(r.lock),
    })),
    audit: audit.map((a) => ({
      ...a,
      actor_function: a.actor_function as ActorFunction,
    })),
    gold_needs: gold_needs,
    gold_coverages: gold_coverages.map((g) => ({
      ...g,
      overall: g.overall as IegpState["gold_coverages"][0]["overall"],
    })),
    gap_versions: gap_versions.map((row) => ({
      ...row,
      status: row.status as IegpState["gaps"][0]["status"],
      domain: row.domain as IegpState["gaps"][0]["domain"],
      event: row.event as IegpState["gap_versions"][0]["event"],
      actor_function: row.actor_function as ActorFunction,
    })),
    breakout_groups: breakout_groups.map((row) => ({
      ...row,
      actor_function: row.actor_function as ActorFunction,
    })),
    breakout_group_gaps: breakout_group_gaps,
  };
}

export async function persistState(state: IegpState) {
  await ensureSchema();
  await wipeIegp();
  const d = db();
  await d.insert(t.assets).values(state.asset);
  if (state.objectives.length) await d.insert(t.objectives).values(state.objectives);
  if (state.sources.length) {
    await d.insert(t.sources).values(state.sources);
  }
  if (state.blocks.length) await d.insert(t.sourceBlocks).values(state.blocks);
  if (state.needs.length) {
    await d.insert(t.needs).values(
      state.needs.map((n) => {
        const { status_lock, ...rest } = n;
        return { ...rest, lock: status_lock };
      }),
    );
  }
  if (state.gaps.length) {
    await d.insert(t.gaps).values(
      state.gaps.map((g) => {
        const { status_lock, ...rest } = g;
        return {
          ...rest,
          lock: status_lock,
          computed_status: g.computed_status ?? null,
          status_override: g.status_override ?? null,
          retired: g.retired ?? false,
          human_validated: g.human_validated ?? false,
          parked_at: g.parked_at ?? null,
          parked_reason: g.parked_reason ?? null,
        };
      }),
    );
  }
  if (state.need_gap_links.length) await d.insert(t.needGapLinks).values(state.need_gap_links);
  if (state.tactics.length) await d.insert(t.tactics).values(state.tactics);
  if (state.coverages.length) await d.insert(t.coverages).values(state.coverages);
  if (state.mapping_suggestions.length) {
    await d.insert(t.mappingSuggestions).values(state.mapping_suggestions);
  }
  if (state.residual_gap_suggestions.length) {
    await d.insert(t.residualGapSuggestions).values(state.residual_gap_suggestions);
  }
  if (state.residuals.length) await d.insert(t.residuals).values(state.residuals);
  if (state.priorities.length) await d.insert(t.priorities).values(state.priorities);
  if (state.roadmap.length) await d.insert(t.roadmap).values(state.roadmap);
  if (state.audit.length) await d.insert(t.audit).values(state.audit);
  if (state.gold_needs.length) await d.insert(t.goldNeeds).values(state.gold_needs);
  if (state.gold_coverages.length) await d.insert(t.goldCoverages).values(state.gold_coverages);
  if (state.gap_versions.length) await d.insert(t.gapVersions).values(state.gap_versions);
  if (state.breakout_groups.length) await d.insert(t.breakoutGroups).values(state.breakout_groups);
  if (state.breakout_group_gaps.length) {
    await d.insert(t.breakoutGroupGaps).values(state.breakout_group_gaps);
  }
}

export async function resetSeed() {
  await persistState(buildBlankWorkspace());
  return loadState();
}

export async function resetWorkedExample() {
  await persistState(buildSeed());
  return loadState();
}

function now() {
  return new Date().toISOString();
}

function nextId(prefix: string, existing: string[]) {
  const nums = existing
    .map((id) => Number(id.split("-").pop()?.replace(/\D/g, "") || 0))
    .filter((n) => Number.isFinite(n));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

const PLAN_ENTRY_SOURCE_ID = "SRC-PLAN-ENTRY";

async function ensurePlanEntrySource(): Promise<string> {
  const state = await loadState();
  if (state.sources.some((s) => s.id === PLAN_ENTRY_SOURCE_ID)) return PLAN_ENTRY_SOURCE_ID;
  await db().insert(t.sources).values({
    id: PLAN_ENTRY_SOURCE_ID,
    filename: "gaps-entry.txt",
    title: "Recorded on Gaps",
    source_type: "other_internal",
    stakeholder_function: "evidence_lead",
    ingested_at: now(),
    full_text: "Gaps created or repaired on the Gaps workbench without an ingest source.",
  });
  return PLAN_ENTRY_SOURCE_ID;
}

async function copyNeedGapLinks(fromGapId: string, toGapId: string) {
  const state = await loadState();
  const links = state.need_gap_links.filter((l) => l.gap_id === fromGapId);
  for (const link of links) {
    await db()
      .insert(t.needGapLinks)
      .values({ need_id: link.need_id, gap_id: toGapId, role: link.role })
      .onConflictDoNothing();
  }
}

async function linkNeedOntoGap(
  needId: string,
  gapId: string,
  role: "primary" | "supporting",
) {
  await db()
    .insert(t.needGapLinks)
    .values({ need_id: needId, gap_id: gapId, role })
    .onConflictDoNothing();
}

async function insertLiveOpenGap(args: {
  name: string;
  statement: string;
  domain: EvidenceDomain;
  objectiveId: string;
}): Promise<string> {
  const live = await loadState();
  const gapId = nextId(
    "GAP",
    live.gaps.map((g) => g.id),
  );
  await db().insert(t.gaps).values({
    id: gapId,
    name: args.name,
    statement: args.statement,
    domain: args.domain,
    objective_id: args.objectiveId,
    status: "validated_open",
    exclusion_reason: null,
    exclusion_note: null,
    lock: unlocked(),
    parent_gap_id: null,
    computed_status: "validated_open",
    status_override: null,
    retired: false,
    human_validated: false,
    parked_at: null,
    parked_reason: null,
  });
  return gapId;
}

async function insertNeedForGap(args: {
  gapId: string;
  sourceId: string;
  statement: string;
  sourceQuote: string;
  role: "primary" | "supporting";
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gapId);
  const obj = state.objectives[0];
  if (!obj) throw new Error("No strategic objective to attach this need to.");
  if (!gap) throw new Error("Gap not found");
  const statement = args.statement.trim();
  if (!statement) return;
  const needId = nextId(
    "NEED",
    state.needs.map((n) => n.id),
  );
  await insertNeedRow({
    id: needId,
    statement,
    source_quote: args.sourceQuote,
    domain: gap.domain,
    stakeholder: args.actor_function,
    source_id: args.sourceId,
    objective: obj,
    geography: state.asset.geography,
  });
  await linkNeedOntoGap(needId, args.gapId, args.role);
}

/**
 * A need row records a sourced statement. PICO fields and confidence stay empty
 * until a model or a human fills them: nothing is invented here.
 */
async function insertNeedRow(args: {
  id: string;
  statement: string;
  source_quote: string;
  domain: EvidenceDomain;
  stakeholder: ActorFunction;
  source_id: string;
  objective: IegpState["objectives"][0];
  geography: string;
}) {
  await db().insert(t.needs).values({
    id: args.id,
    statement: args.statement,
    domain: args.domain,
    stakeholder: args.stakeholder,
    objective_id: args.objective.id,
    decision_supported: args.objective.key_decision,
    geography: args.geography,
    population: "",
    intervention: "",
    comparator: "",
    outcome: "",
    timing: "",
    source_id: args.source_id,
    source_quote: args.source_quote.trim().slice(0, 280) || args.statement.slice(0, 280),
    confidence: null,
    status: "candidate",
    lock: unlocked(),
  });
}

export async function ensureGapHasConstituentNeed(gapId: string) {
  let state = await loadState();
  const gap = state.gaps.find((g) => g.id === gapId);
  if (!gap) return;
  if (state.need_gap_links.some((l) => l.gap_id === gapId)) return;
  if (gap.parent_gap_id) {
    await ensureGapHasConstituentNeed(gap.parent_gap_id);
    await copyNeedGapLinks(gap.parent_gap_id, gapId);
    state = await loadState();
    if (state.need_gap_links.some((l) => l.gap_id === gapId)) return;
  }
  // No similarity lookup: an existing need joins a gap only through an explicit
  // link (lockNeed with gap_id). Otherwise the gap's own statement is its need.
  const sourceId = await ensurePlanEntrySource();
  const actor = (gap.status_lock.actor_function as ActorFunction | null) || "evidence_lead";
  await insertNeedForGap({
    gapId,
    sourceId,
    statement: gap.statement,
    sourceQuote: gap.statement,
    role: "primary",
    actor_function: actor,
  });
}

export async function ensureAllLiveGapsHaveNeeds() {
  const state = await loadState();
  for (const gap of state.gaps.filter(isLiveGap)) {
    await ensureGapHasConstituentNeed(gap.id);
  }
}

export async function appendAudit(
  actor_name: string,
  actor_function: ActorFunction,
  entity_type: string,
  entity_id: string,
  action: string,
  detail: string,
) {
  await db().insert(t.audit).values({
    id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: now(),
    actor_name,
    actor_function,
    entity_type,
    entity_id,
    action,
    detail,
  });
}

export function makeLock(
  name: string,
  fn: ActorFunction,
  note?: string,
): Lock {
  return {
    locked: true,
    actor_name: name,
    actor_function: fn,
    locked_at: now(),
    note: note ?? null,
  };
}

export async function lockNeed(args: {
  need_id: string;
  status: "accepted" | "rejected";
  gap_id?: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const need = state.needs.find((n) => n.id === args.need_id);
  if (!need) throw new Error("Need not found");
  const lk = makeLock(args.actor_name, args.actor_function, args.note);
  await db()
    .update(t.needs)
    .set({ status: args.status, lock: lk })
    .where(eq(t.needs.id, args.need_id));
  if (args.status === "accepted" && args.gap_id) {
    await db()
      .insert(t.needGapLinks)
      .values({ need_id: args.need_id, gap_id: args.gap_id, role: "supporting" })
      .onConflictDoNothing();
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "need",
    args.need_id,
    "lock_status",
    `${need.status} → ${args.status}`,
  );
  const rationale = args.note?.trim() ?? "";
  if (rationale.length >= 3) {
    await recordEdit({
      stage: "S2",
      entity_type: "need",
      entity_id: args.need_id,
      field: "status",
      action: args.status === "accepted" ? "accept" : "reject",
      before: need.status,
      after: args.gap_id ? `${args.status} → ${args.gap_id}` : args.status,
      rationale,
      actor: { name: args.actor_name, function: args.actor_function },
    });
  }
}

type FieldChange = { field: string; before: string | null; after: string | null };

/** Files one edit record per changed field, each with its before and after value. */
async function recordFieldEdits(args: {
  stage: "S2" | "S3" | "S6";
  entity_type: string;
  entity_id: string;
  changes: FieldChange[];
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  for (const change of args.changes) {
    await recordEdit({
      stage: args.stage,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      field: change.field,
      action: "edit",
      before: change.before,
      after: change.after,
      rationale: args.rationale,
      actor: { name: args.actor_name, function: args.actor_function },
    });
  }
}

/** Compares a draft with the stored row; only fields the draft names and changes are returned. */
function diffFields(
  row: object,
  draft: Record<string, string | null | undefined>,
): FieldChange[] {
  const stored = row as Record<string, unknown>;
  const out: FieldChange[] = [];
  for (const [field, value] of Object.entries(draft)) {
    if (value === undefined) continue;
    const before = (stored[field] ?? null) as string | null;
    if (before === value) continue;
    out.push({ field, before, after: value });
  }
  return out;
}

/**
 * Human edit of a need's wording or its source quote. The need is locked to the
 * editor; no stage rewrites an existing need, so the edit survives every re-run.
 */
export async function editNeed(args: {
  need_id: string;
  statement?: string;
  source_quote?: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const need = state.needs.find((n) => n.id === args.need_id);
  if (!need) throw new Error("Need not found");
  const statement = args.statement === undefined ? undefined : args.statement.trim();
  if (statement !== undefined && !statement) throw new Error("Need statement is required.");
  const quote = args.source_quote === undefined ? undefined : args.source_quote.trim();
  const changes = diffFields(need, { statement, source_quote: quote });
  if (changes.length === 0) throw new Error("Nothing changed.");
  await db()
    .update(t.needs)
    .set({
      ...(statement !== undefined ? { statement } : {}),
      ...(quote !== undefined ? { source_quote: quote } : {}),
      lock: makeLock(args.actor_name, args.actor_function, rationale),
    })
    .where(eq(t.needs.id, args.need_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "need",
    args.need_id,
    "edit",
    `${changes.map((c) => c.field).join(", ")}: ${rationale}`,
  );
  await recordFieldEdits({
    stage: "S2",
    entity_type: "need",
    entity_id: args.need_id,
    changes,
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
}

/**
 * A need a person records by hand onto a gap (e.g. from a meeting no source file
 * covers). It is accepted and locked to them, with the plan-entry source unless
 * they name an ingested one.
 */
export async function createNeed(args: {
  gap_id: string;
  statement: string;
  source_quote?: string;
  source_id?: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<string> {
  const rationale = requireRationale(args.rationale);
  const statement = args.statement.trim();
  if (!statement) throw new Error("Need statement is required.");
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap || gap.retired) throw new Error("Gap not found");
  const sourceId =
    args.source_id && state.sources.some((s) => s.id === args.source_id)
      ? args.source_id
      : await ensurePlanEntrySource();
  const hasPrimary = state.need_gap_links.some((l) => l.gap_id === gap.id && l.role === "primary");
  const before = new Set(state.needs.map((n) => n.id));
  await insertNeedForGap({
    gapId: gap.id,
    sourceId,
    statement,
    sourceQuote: args.source_quote?.trim() || statement,
    role: hasPrimary ? "supporting" : "primary",
    actor_function: args.actor_function,
  });
  const created = (await loadState()).needs.find((n) => !before.has(n.id));
  if (!created) throw new Error("The need was not saved.");
  await db()
    .update(t.needs)
    .set({ status: "accepted", lock: makeLock(args.actor_name, args.actor_function, rationale) })
    .where(eq(t.needs.id, created.id));
  await appendAudit(args.actor_name, args.actor_function, "need", created.id, "create", `${gap.id}: ${rationale}`);
  await recordEdit({
    stage: "S2",
    entity_type: "need",
    entity_id: created.id,
    field: "created",
    action: "add",
    before: null,
    after: `${gap.id}: ${statement}`,
    rationale,
    actor: { name: args.actor_name, function: args.actor_function },
  });
  return created.id;
}

/** Removes one need → gap link; the old gap's primary passes to its next need. */
async function dropNeedLink(state: IegpState, need_id: string, gap_id: string) {
  const link = state.need_gap_links.find((l) => l.need_id === need_id && l.gap_id === gap_id);
  if (!link) throw new Error(`${need_id} is not linked to ${gap_id}.`);
  const gap = state.gaps.find((g) => g.id === gap_id);
  const others = state.need_gap_links.filter((l) => l.gap_id === gap_id && l.need_id !== need_id);
  if (gap && isLiveGap(gap) && others.length === 0) {
    throw new Error(
      "This is the gap's only need. Link or move another need onto it first, or park or exclude the gap.",
    );
  }
  await db()
    .delete(t.needGapLinks)
    .where(and(eq(t.needGapLinks.need_id, need_id), eq(t.needGapLinks.gap_id, gap_id)));
  if (link.role === "primary" && others.length > 0 && !others.some((l) => l.role === "primary")) {
    await db()
      .update(t.needGapLinks)
      .set({ role: "primary" })
      .where(and(eq(t.needGapLinks.need_id, others[0]!.need_id), eq(t.needGapLinks.gap_id, gap_id)));
  }
}

export async function unlinkNeedFromGap(args: {
  need_id: string;
  gap_id: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const need = state.needs.find((n) => n.id === args.need_id);
  if (!need) throw new Error("Need not found");
  await dropNeedLink(state, args.need_id, args.gap_id);
  await db()
    .update(t.needs)
    .set({ lock: makeLock(args.actor_name, args.actor_function, rationale) })
    .where(eq(t.needs.id, args.need_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "need",
    args.need_id,
    "unlink",
    `${args.need_id} ✕ ${args.gap_id}: ${rationale}`,
  );
  await recordEdit({
    stage: "S2",
    entity_type: "need",
    entity_id: args.need_id,
    field: "gap_link",
    action: "edit",
    before: args.gap_id,
    after: null,
    rationale,
    actor: { name: args.actor_name, function: args.actor_function },
  });
}

/**
 * Moves a need from one gap onto another, or onto a new gap made from the need.
 * This is how a person corrects an S2 merge: the judge joined a need onto the
 * wrong gap, or merged two different questions. Later S2 runs only add needs;
 * they never re-link an existing one, so the move survives every re-run.
 */
export async function moveNeedToGap(args: {
  need_id: string;
  from_gap_id: string;
  /** Leave empty and set `new_gap` to split the need out as its own gap. */
  to_gap_id?: string;
  new_gap?: boolean;
  new_gap_name?: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<string> {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const need = state.needs.find((n) => n.id === args.need_id);
  if (!need) throw new Error("Need not found");
  const toId = args.to_gap_id?.trim() || "";
  if (!toId && !args.new_gap) throw new Error("Choose the gap to move this need onto.");
  if (toId === args.from_gap_id) throw new Error("The need is already on that gap.");
  if (toId) {
    const target = state.gaps.find((g) => g.id === toId);
    if (!target || target.retired) throw new Error("Target gap not found");
  }
  await dropNeedLink(state, args.need_id, args.from_gap_id);
  let targetId = toId;
  if (!targetId) {
    targetId = await createGap({
      name: args.new_gap_name?.trim() || undefined,
      statement: need.statement,
      domain: need.domain,
      need_id: need.id,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: rationale,
    });
  } else {
    const hasPrimary = state.need_gap_links.some((l) => l.gap_id === targetId && l.role === "primary");
    await linkNeedOntoGap(args.need_id, targetId, hasPrimary ? "supporting" : "primary");
  }
  await db()
    .update(t.needs)
    .set({ lock: makeLock(args.actor_name, args.actor_function, rationale) })
    .where(eq(t.needs.id, args.need_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "need",
    args.need_id,
    "move",
    `${args.from_gap_id} → ${targetId}: ${rationale}`,
  );
  await recordEdit({
    stage: "S2",
    entity_type: "need",
    entity_id: args.need_id,
    field: "gap_link",
    action: "edit",
    before: args.from_gap_id,
    after: targetId,
    rationale,
    actor: { name: args.actor_name, function: args.actor_function },
  });
  return targetId;
}

function childParents(state: IegpState): Set<string> {
  return new Set(
    state.gaps.map((g) => g.parent_gap_id).filter((id): id is string => Boolean(id)),
  );
}

/**
 * An Addressed gap has no leftover, so a pending leftover row is closed. A
 * Partial gap gets no drafted leftover here: leftovers come from S6 (the model,
 * on demand) or a human.
 */
async function applyMappedStatusSideEffects(args: {
  gap_id: string;
  status: MappedGapStatus;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  if (args.status === "validated_addressed") {
    const after = await loadState();
    const existing = after.residual_gap_suggestions.find((row) => row.parent_gap_id === args.gap_id);
    if (existing?.status === "candidate") {
      await upsertResidualGapSuggestion({
        parent_gap_id: args.gap_id,
        statement: existing.statement,
        reasons: existing.reasons,
        status: "rejected",
        actor_name: args.actor_name,
        actor_function: args.actor_function,
        note: "Addressed. No residual.",
      });
    }
  }
}

/**
 * A gap a person validated and whose lock still stands. The engine may not take
 * its status or its validation away; a disagreeing computation is flagged stale
 * for that person to review.
 */
function humanHeldStatus(gap: IegpState["gaps"][0]): MappedGapStatus | null {
  if (!gap.human_validated || !gap.status_lock.locked) return null;
  return gap.status === "validated_open" || gap.status === "validated_addressed" ? gap.status : null;
}

/**
 * Recomputes Open / Partial / Addressed from coverage. `human` marks a change a
 * person just made (their coverage or mapping edit): the new computation then
 * applies. Otherwise (a model run, an ingest) a human override or a
 * human-validated status is kept and only flagged stale when it disagrees.
 */
export async function syncComputedGapStatuses(gapId?: string, opts?: { human?: boolean }) {
  const state = await loadState();
  const children = childParents(state);
  const gaps = gapId ? state.gaps.filter((g) => g.id === gapId) : state.gaps;
  for (const gap of gaps) {
    if (gap.status === "candidate" || gap.status === "excluded" || gap.retired) {
      if (gap.computed_status !== null) {
        await db().update(t.gaps).set({ computed_status: null }).where(eq(t.gaps.id, gap.id));
      }
      continue;
    }
    const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
    const computed = computeGapStatus(coverages, state.tactics, {
      hasAcceptedChild: children.has(gap.id),
    });
    const override = gap.status_override;
    if (override) {
      const stale = override.status !== computed;
      await db()
        .update(t.gaps)
        .set({
          computed_status: computed,
          status: override.status,
          status_override: { ...override, stale },
        })
        .where(eq(t.gaps.id, gap.id));
      if (stale && !override.stale) {
        await appendAudit(
          "Engine",
          "evidence_lead",
          "gap",
          gap.id,
          "status_override_stale",
          `Override ${override.status} disagrees with computed ${computed}`,
        );
      }
      continue;
    }
    const held = opts?.human ? null : humanHeldStatus(gap);
    if (held && held !== computed) {
      const lock = gap.status_lock;
      const kept: GapStatusOverride = {
        status: held,
        from: held,
        to: held,
        reason: lock.note?.trim() || `Validated ${held} by a person; kept after a coverage change.`,
        actor_name: lock.actor_name ?? "Human",
        actor_function: lock.actor_function ?? "evidence_lead",
        at: lock.locked_at ?? now(),
        stale: true,
      };
      await db()
        .update(t.gaps)
        .set({ computed_status: computed, status_override: kept })
        .where(eq(t.gaps.id, gap.id));
      await appendAudit(
        "Engine",
        "evidence_lead",
        "gap",
        gap.id,
        "status_override_stale",
        `Human-validated ${held} kept; engine now computes ${computed}`,
      );
      continue;
    }
    if (gap.status === computed && gap.computed_status !== computed) {
      // Same status, newly recorded computation: nothing a person decided changes.
      await db().update(t.gaps).set({ computed_status: computed }).where(eq(t.gaps.id, gap.id));
      continue;
    }
    if (gap.status !== computed) {
      await db()
        .update(t.gaps)
        .set({
          status: computed,
          computed_status: computed,
          lock: unlocked(),
          status_override: null,
          human_validated: false,
        })
        .where(eq(t.gaps.id, gap.id));
      await appendAudit(
        "Engine",
        "evidence_lead",
        "gap",
        gap.id,
        "compute_status",
        `${gap.status} → ${computed}`,
      );
      await applyMappedStatusSideEffects({
        gap_id: gap.id,
        status: computed,
        actor_name: "Engine",
        actor_function: "evidence_lead",
      });
    }
  }
}

export async function lockGapStatus(args: {
  gap_id: string;
  status: IegpState["gaps"][0]["status"];
  exclusion_reason?: IegpState["gaps"][0]["exclusion_reason"];
  exclusion_note?: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (args.status === "validated_partial") {
    throw new Error("Partially Addressed cannot stay. Split or rewrite the gap instead.");
  }
  if (displayedGapStatus(gap) === "validated_partial" && args.status !== "excluded") {
    throw new Error("Partially Addressed cannot stay. Split or rewrite the gap instead.");
  }
  if (args.status === "validated_addressed") {
    const cov = state.coverages.filter((c) => c.gap_id === args.gap_id);
    const computed = computeGapStatus(cov, state.tactics, {
      hasAcceptedChild: childParents(state).has(gap.id),
    });
    if (computed !== "validated_addressed" && !args.note) {
      throw new Error(
        "A reason is required to override computed gap status. Cannot lock Addressed unless coverage is Full.",
      );
    }
  }
  const lk = makeLock(args.actor_name, args.actor_function, args.note);
  // Partial was already rejected above, so only Open and Addressed remain mapped.
  const mapped = args.status === "validated_open" || args.status === "validated_addressed";
  const wasMapped =
    gap.status === "validated_open" ||
    gap.status === "validated_partial" ||
    gap.status === "validated_addressed";
  const asOverride = Boolean(wasMapped && mapped && args.note?.trim());
  const override = asOverride
    ? {
        status: args.status as MappedGapStatus,
        from: gap.status,
        to: args.status as MappedGapStatus,
        reason: args.note!.trim(),
        actor_name: args.actor_name,
        actor_function: args.actor_function,
        at: now(),
        stale: false,
      }
    : mapped
      ? gap.status_override
      : null;
  await db()
    .update(t.gaps)
    .set({
      status: args.status,
      exclusion_reason: args.exclusion_reason ?? null,
      exclusion_note: args.exclusion_note ?? null,
      lock: lk,
      computed_status: mapped ? (gap.computed_status ?? args.status) : null,
      status_override: override,
      ...(args.status === "excluded" ? { parked_at: null, parked_reason: null } : {}),
    })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "lock_status",
    `${gap.status} → ${args.status}`,
  );
  if (mapped) {
    await syncComputedGapStatuses(args.gap_id);
  }
}

export async function overrideGapStatus(args: {
  gap_id: string;
  status: MappedGapStatus;
  reason?: string;
  note?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (args.status === "validated_partial" || displayedGapStatus(gap) === "validated_partial") {
    throw new Error("Partially Addressed cannot stay. Split or rewrite the gap instead.");
  }
  if (gap.status === "candidate" || gap.status === "excluded" || gap.retired) {
    throw new Error("Only live Open or Addressed gaps can be overridden.");
  }
  const reason = requireOverrideReason(args.reason ?? args.note);
  const coverages = state.coverages.filter((c) => c.gap_id === args.gap_id);
  const computed =
    gap.computed_status ??
    computeGapStatus(coverages, state.tactics, {
      hasAcceptedChild: childParents(state).has(gap.id),
    });
  const from = gap.status;
  const override: GapStatusOverride = {
    status: args.status,
    from,
    to: args.status,
    reason,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    at: now(),
    stale: args.status !== computed,
  };
  await db()
    .update(t.gaps)
    .set({
      status: args.status,
      computed_status: computed,
      status_override: override,
      lock: makeLock(args.actor_name, args.actor_function, reason),
    })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "override_status",
    `${from} → ${args.status}: ${reason}`,
  );
  await applyMappedStatusSideEffects({
    gap_id: args.gap_id,
    status: args.status,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
}

export async function clearGapStatusOverride(args: {
  gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  await db()
    .update(t.gaps)
    .set({ status_override: null, lock: unlocked() })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "clear_status_override",
    args.note || `Cleared override; engine computed ${gap.computed_status ?? "status"} applies.`,
  );
  await syncComputedGapStatuses(args.gap_id);
}

export async function parkGap(args: {
  gap_id: string;
  reason?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (gap.retired) throw new Error("A retired gap cannot be parked.");
  if (gap.status === "excluded") throw new Error("An excluded gap cannot be parked.");
  if (gap.parked_at) throw new Error("This gap is already parked.");
  const reason = (args.reason ?? "").trim();
  if (!reason) throw new Error("A reason is required to park a gap.");
  await db()
    .update(t.gaps)
    .set({ parked_at: now(), parked_reason: reason })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(args.actor_name, args.actor_function, "gap", args.gap_id, "park", reason);
}

export async function setGapSettings(args: {
  gap_id: string;
  settings: string[];
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<string[]> {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (gap.retired) throw new Error("A retired gap cannot be re-tagged.");
  const settings = normalizeSettings(args.settings);
  await db().update(t.gaps).set({ settings }).where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "set_settings",
    settings.length ? settings.join(", ") : "No setting",
  );
  return settings;
}

export async function unparkGap(args: {
  gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (!gap.parked_at) throw new Error("This gap is not parked.");
  await db()
    .update(t.gaps)
    .set({ parked_at: null, parked_reason: null })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "unpark",
    args.note || "Brought back from parked.",
  );
}

export async function classifyMappedGap(args: {
  gap_id: string;
  status: MappedGapStatus;
  confirm_unfilled?: boolean;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  await overrideGapStatus({
    gap_id: args.gap_id,
    status: args.status,
    reason: args.note,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
}

export async function lockCoverageDimension(args: {
  coverage_id: string;
  dimension: keyof IegpState["coverages"][0]["dimensions"];
  value: IegpState["coverages"][0]["dimensions"][typeof args.dimension]["value"];
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  if (!(COVERAGE_DIMENSIONS as readonly string[]).includes(args.dimension)) {
    throw new Error(`Unknown coverage dimension "${String(args.dimension)}".`);
  }
  if (!(DIMENSION_VALUES as readonly string[]).includes(args.value)) {
    throw new Error(`Choose a dimension value (${DIMENSION_VALUES.join(", ")}).`);
  }
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const row = state.coverages.find((c) => c.id === args.coverage_id);
  if (!row) throw new Error("Coverage not found");
  const before = row.dimensions[args.dimension]?.value;
  const dimensions = {
    ...row.dimensions,
    [args.dimension]: {
      value: args.value,
      rationale,
      lock: makeLock(args.actor_name, args.actor_function, rationale),
    },
  };
  await db()
    .update(t.coverages)
    .set({ dimensions, stale: false, needs_review: false })
    .where(eq(t.coverages.id, args.coverage_id));
  await flagSiblingCoveragesForReview(row.tactic_id, row.gap_id);
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    args.coverage_id,
    "lock_dimension",
    `${args.dimension}: ${before ?? "unknown"} → ${args.value}: ${rationale}`,
  );
  await syncComputedGapStatuses(row.gap_id, { human: true });
}

export async function lockCoverageOverall(args: {
  coverage_id: string;
  overall: IegpState["coverages"][0]["overall"];
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  if (!(ASSESSED_COVERAGE as readonly string[]).includes(args.overall)) {
    throw new Error(`Choose a coverage verdict (${ASSESSED_COVERAGE.join(", ")}).`);
  }
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const row = state.coverages.find((c) => c.id === args.coverage_id);
  if (!row) throw new Error("Coverage not found");
  await db()
    .update(t.coverages)
    .set({
      overall: args.overall,
      overall_rationale: rationale,
      overall_lock: makeLock(args.actor_name, args.actor_function, rationale),
      stale: false,
      needs_review: false,
    })
    .where(eq(t.coverages.id, args.coverage_id));
  await flagSiblingCoveragesForReview(row.tactic_id, row.gap_id);
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    args.coverage_id,
    "lock_overall",
    `${row.overall} → ${args.overall}: ${rationale}`,
  );
  await syncComputedGapStatuses(row.gap_id, { human: true });
}

async function flagSiblingCoveragesForReview(tactic_id: string, except_gap_id: string) {
  const state = await loadState();
  const liveGapIds = new Set(state.gaps.filter(isLiveGap).map((g) => g.id));
  const siblings = state.coverages.filter(
    (c) => c.tactic_id === tactic_id && c.gap_id !== except_gap_id && liveGapIds.has(c.gap_id),
  );
  for (const sibling of siblings) {
    if (sibling.needs_review) continue;
    await db()
      .update(t.coverages)
      .set({ needs_review: true })
      .where(eq(t.coverages.id, sibling.id));
  }
}

export async function confirmCoverageReview(args: {
  coverage_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const row = state.coverages.find((c) => c.id === args.coverage_id);
  if (!row) throw new Error("Coverage not found");
  await db()
    .update(t.coverages)
    .set({ needs_review: false })
    .where(eq(t.coverages.id, args.coverage_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    args.coverage_id,
    "confirm_coverage_review",
    args.note || "Confirmed coverage after a sibling gap change. Values unchanged.",
  );
  await syncComputedGapStatuses(row.gap_id);
}



export async function lockResidual(args: {
  residual_id: string;
  statement: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  await db()
    .update(t.residuals)
    .set({
      statement: args.statement,
      lock: makeLock(args.actor_name, args.actor_function, args.note),
    })
    .where(eq(t.residuals.id, args.residual_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "residual",
    args.residual_id,
    "lock",
    args.statement.slice(0, 180),
  );
}

export async function lockPriority(args: {
  residual_id: string;
  band: IegpState["priorities"][0]["band"];
  override_reason?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const residual = state.residuals.find((r) => r.id === args.residual_id);
  if (!residual) throw new Error("Residual not found");
  const existing = state.priorities.find((p) => p.residual_id === args.residual_id);
  const row = {
    residual_id: args.residual_id,
    suggested_score: 0,
    suggested_band: args.band,
    band: args.band,
    override_reason: args.override_reason ?? null,
    reasons: ["Human-locked. The engine does not assign priority."],
    lock: makeLock(args.actor_name, args.actor_function, args.override_reason),
  };
  if (existing) {
    await db().update(t.priorities).set(row).where(eq(t.priorities.id, existing.id));
  } else {
    await db().insert(t.priorities).values({
      id: nextId("PRI", state.priorities.map((p) => p.id)),
      ...row,
    });
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "priority",
    args.residual_id,
    "lock_band",
    args.band,
  );
}

export const GAPS_PROPOSED_CREATE_ERROR =
  "Gaps cannot create proposed tactics. Record a completed, ongoing, or planned study, or invent on Tactics after you prioritize.";

function requireCatchUpStatus(status: string | undefined): CatchUpTacticStatus {
  if (!status || status === "proposed" || status === "cancelled") {
    throw new Error(GAPS_PROPOSED_CREATE_ERROR);
  }
  if (!(CATCH_UP_TACTIC_STATUSES as readonly string[]).includes(status)) {
    throw new Error(GAPS_PROPOSED_CREATE_ERROR);
  }
  return status as CatchUpTacticStatus;
}

function optionalCatchUpReason(value?: string | null): CatchUpReason | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!(CATCH_UP_REASONS as readonly string[]).includes(trimmed)) {
    throw new Error("Unknown catch-up reason.");
  }
  return trimmed as CatchUpReason;
}

type LibraryTacticDraft = {
  name: string;
  type: IegpState["tactics"][0]["type"];
  description: string;
  evidence_question: string;
  population?: string;
  intervention?: string;
  comparator?: string;
  outcomes?: string;
  geography?: string;
  owner?: string;
  function?: ActorFunction;
  residual_ids?: string[];
  status: IegpState["tactics"][0]["status"];
  lifecycle_stage: string;
  intended_use?: string;
  data_source?: string;
  study_design?: string;
  source_quote?: string;
  actor_name: string;
  actor_function: ActorFunction;
  audit_action: string;
  note?: string;
};

async function insertLibraryTactic(args: LibraryTacticDraft) {
  const state = await loadState();
  if (!args.name.trim()) throw new Error("Tactic name is required.");
  if (!args.evidence_question.trim()) throw new Error("Evidence question is required.");
  if (!TACTIC_TYPES.includes(args.type)) throw new Error("Tactic type is required.");
  const id = nextId("TAC", state.tactics.map((x) => x.id));
  const reasonNote = args.note?.trim() || null;
  await db().insert(t.tactics).values({
    id,
    name: args.name.trim(),
    type: args.type,
    description: args.description || args.name.trim(),
    evidence_question: args.evidence_question.trim(),
    population: args.population ?? "",
    intervention: args.intervention ?? "",
    comparator: args.comparator ?? "",
    outcomes: args.outcomes ?? "",
    // A field the form sent blank stays blank; only an omitted geography takes the asset's.
    geography: args.geography === undefined ? state.asset.geography : args.geography.trim(),
    data_source: args.data_source?.trim() ?? "",
    study_design: args.study_design?.trim() ?? "",
    source_quote: args.source_quote?.trim() ?? "",
    lifecycle_stage: args.lifecycle_stage,
    status: args.status,
    review_status: "accepted",
    start_date: null,
    evidence_available: null,
    owner: args.owner || args.actor_name,
    function: args.function || "evidence_lead",
    budget: null,
    intended_use: args.intended_use || (args.residual_ids || []).join(", "),
    lock: reasonNote ? makeLock(args.actor_name, args.actor_function, reasonNote) : unlocked(),
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "tactic",
    id,
    args.audit_action,
    args.name.trim(),
  );
  return id;
}

export async function createProposedTactic(args: {
  name: string;
  type: IegpState["tactics"][0]["type"];
  description: string;
  evidence_question: string;
  population: string;
  intervention: string;
  comparator: string;
  outcomes: string;
  geography?: string;
  study_design?: string;
  data_source?: string;
  owner: string;
  function: ActorFunction;
  residual_ids: string[];
  gap_id?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const id = await insertLibraryTactic({
    name: args.name,
    type: args.type,
    description: args.description,
    evidence_question: args.evidence_question,
    population: args.population,
    intervention: args.intervention,
    comparator: args.comparator,
    outcomes: args.outcomes,
    geography: args.geography,
    study_design: args.study_design,
    data_source: args.data_source,
    owner: args.owner,
    function: args.function,
    residual_ids: args.residual_ids,
    status: "proposed",
    lifecycle_stage: "proposed",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    audit_action: "create_proposed",
  });
  if (args.gap_id) {
    await assignTacticToGap({
      gap_id: args.gap_id,
      tactic_id: id,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: "Created from the plan and assigned to this gap.",
    });
  }
  return id;
}

/** Gaps catch-up create. Rejects `proposed` — ideation is Tactics after Prioritize. */
export async function recordMissedTactic(args: {
  name: string;
  type: IegpState["tactics"][0]["type"];
  description?: string;
  evidence_question: string;
  population?: string;
  intervention?: string;
  comparator?: string;
  outcomes?: string;
  geography?: string;
  owner?: string;
  function?: ActorFunction;
  residual_ids?: string[];
  gap_id?: string;
  status: string;
  catch_up_reason?: string;
  study_design?: string;
  data_source?: string;
  /** The source sentence, when the tactic is promoted from a rejected S3 candidate. */
  source_quote?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const status = requireCatchUpStatus(args.status);
  const reason = optionalCatchUpReason(args.catch_up_reason);
  const reasonLabel = reason ? CATCH_UP_REASON_LABELS[reason] : undefined;
  const id = await insertLibraryTactic({
    name: args.name,
    type: args.type,
    description:
      args.description ||
      `Recorded as catch-up (${status}). Not ideation.`,
    evidence_question: args.evidence_question,
    population: args.population,
    intervention: args.intervention,
    comparator: args.comparator,
    outcomes: args.outcomes,
    geography: args.geography,
    owner: args.owner,
    function: args.function,
    residual_ids: args.residual_ids,
    status,
    lifecycle_stage: "recorded",
    intended_use: reasonLabel || (args.residual_ids || []).join(", "),
    data_source: args.data_source?.trim() || reasonLabel || "Recorded while reviewing gaps",
    study_design: args.study_design,
    source_quote: args.source_quote,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    audit_action: "record_missed",
    note: reasonLabel,
  });
  if (args.gap_id) {
    await assignTacticToGap({
      gap_id: args.gap_id,
      tactic_id: id,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: reasonLabel
        ? `Recorded missed tactic (${reasonLabel}) and mapped onto this gap.`
        : "Recorded missed tactic and mapped onto this gap.",
    });
  }
  return id;
}

/** Gaps create-tactic path. Same as recordMissedTactic — rejects `proposed`. */
export async function createTacticFromGaps(
  args: Parameters<typeof recordMissedTactic>[0],
) {
  return recordMissedTactic(args);
}

function coverageVerdict(value: unknown): OverallCoverage | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (OVERALL_COVERAGE as readonly string[]).includes(value)) {
    return value as OverallCoverage;
  }
  throw new Error(
    `Unknown coverage "${String(value)}". Use one of: ${OVERALL_COVERAGE.filter((v) => v !== "unassessed").join(", ")}.`,
  );
}

function coverageDimensions(
  value: Partial<Record<CoverageDimension, DimensionValue>> | null | undefined,
  rationale: string,
): IegpState["coverages"][0]["dimensions"] {
  const dimensions = emptyDimensions();
  if (!value) return dimensions;
  for (const [dim, raw] of Object.entries(value)) {
    if (!(COVERAGE_DIMENSIONS as readonly string[]).includes(dim)) {
      throw new Error(`Unknown coverage dimension "${dim}".`);
    }
    if (!(DIMENSION_VALUES as readonly string[]).includes(raw as string)) {
      throw new Error(`Unknown value "${String(raw)}" for coverage dimension ${dim}.`);
    }
    dimensions[dim as CoverageDimension] = {
      value: raw as DimensionValue,
      rationale,
      lock: unlocked(),
    };
  }
  return dimensions;
}

/**
 * A pair a person rejected or removed. A model run may never map it again;
 * only a person can (assignTacticToGap with `human`).
 */
function humanRejection(state: IegpState, gap_id: string, tactic_id: string) {
  return state.mapping_suggestions.find(
    (m) => m.gap_id === gap_id && m.tactic_id === tactic_id && m.status === "rejected" && m.lock.locked,
  );
}

/** `gap_id::tactic_id` of every pair a person rejected or removed. */
export function humanRejectedPairs(state: IegpState): Set<string> {
  return new Set(
    state.mapping_suggestions
      .filter((m) => m.status === "rejected" && m.lock.locked && !isMappingRowKey(m.tactic_id))
      .map((m) => `${m.gap_id}::${m.tactic_id}`),
  );
}

/**
 * Writes one gap ↔ tactic coverage row. `coverage` and `dimensions` carry the
 * verdict of whoever decided the mapping (the S4 model, or a human). Without a
 * verdict the row is "unassessed" with every dimension "unknown" — nothing is
 * invented. A model's verdict is stored unlocked; a human lock (lockCoverage*,
 * or `lock_coverage` here) is what can make a gap Addressed.
 *
 * `human` marks a person's mapping: it records the pair as human-accepted and
 * may re-map a pair that person (or another) rejected or removed. Without it
 * (a model run) a human-rejected pair is refused.
 */
export async function assignTacticToGap(args: {
  gap_id: string;
  tactic_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
  coverage?: OverallCoverage | null;
  dimensions?: Partial<Record<CoverageDimension, DimensionValue>> | null;
  human?: boolean;
  /** Human only: the given verdict and dimensions are the person's and are locked. */
  lock_coverage?: boolean;
}): Promise<string> {
  const overall = coverageVerdict(args.coverage) ?? "unassessed";
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  if (tactic.review_status !== "accepted") {
    throw new Error("Only accepted tactics can be assigned to a gap.");
  }
  const rejection = humanRejection(state, args.gap_id, args.tactic_id);
  if (rejection && !args.human) {
    throw new Error(
      `${rejection.lock.actor_name ?? "A reviewer"} rejected or removed "${tactic.name}" for this gap; only a person can map it again.`,
    );
  }
  const existing = state.coverages.find(
    (c) => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id,
  );
  if (existing) {
    throw new Error("That tactic is already assigned to this gap.");
  }
  const givenDimensions = Object.keys(args.dimensions ?? {}) as CoverageDimension[];
  const lockVerdict =
    Boolean(args.human && args.lock_coverage) && (overall !== "unassessed" || givenDimensions.length > 0);
  const rationale = lockVerdict
    ? requireRationale(args.note)
    : args.note ||
      "Assigned from the plan. Coverage is not assessed until a model or a human records it.";
  const dimensions = coverageDimensions(args.dimensions, args.note ?? "");
  if (lockVerdict) {
    for (const dim of givenDimensions) {
      dimensions[dim] = { ...dimensions[dim], lock: makeLock(args.actor_name, args.actor_function, rationale) };
    }
  }
  const coverageId = nextId("COV", state.coverages.map((c) => c.id));
  await db().insert(t.coverages).values({
    id: coverageId,
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    dimensions,
    overall,
    overall_rationale: rationale,
    overall_lock:
      lockVerdict && overall !== "unassessed"
        ? makeLock(args.actor_name, args.actor_function, rationale)
        : unlocked(),
    stale: false,
    needs_review: false,
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    coverageId,
    "assign_tactic",
    `${args.tactic_id} → ${args.gap_id}${lockVerdict ? ` (${overall}, set by a person)` : ""}`,
  );
  if (args.human) {
    await upsertMappingSuggestion({
      gap_id: args.gap_id,
      tactic_id: args.tactic_id,
      status: "accepted",
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: rationale,
    });
  }
  await syncComputedGapStatuses(args.gap_id, { human: args.human });
  return coverageId;
}

/**
 * Removes a gap ↔ tactic mapping a person no longer wants. The pair is recorded
 * as rejected by that person, so no later model run maps it again.
 */
export async function unassignTacticFromGap(args: {
  gap_id: string;
  tactic_id: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  const row = state.coverages.find((c) => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id);
  if (!row) throw new Error("That tactic is not mapped to this gap.");
  await db().delete(t.coverages).where(eq(t.coverages.id, row.id));
  await upsertMappingSuggestion({
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    status: "rejected",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: rationale,
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    row.id,
    "unassign_tactic",
    `${args.tactic_id} ↛ ${args.gap_id} (was ${row.overall}): ${rationale}`,
  );
  await syncComputedGapStatuses(args.gap_id, { human: true });
}

async function upsertMappingSuggestion(args: {
  gap_id: string;
  tactic_id: string;
  status: "accepted" | "rejected";
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const row = {
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    status: args.status,
    lock: makeLock(args.actor_name, args.actor_function, args.note),
  };
  const existing = state.mapping_suggestions.find(
    (m) => m.gap_id === args.gap_id && m.tactic_id === args.tactic_id,
  );
  if (existing) {
    await db()
      .update(t.mappingSuggestions)
      .set({ status: row.status, lock: row.lock })
      .where(
        and(eq(t.mappingSuggestions.gap_id, args.gap_id), eq(t.mappingSuggestions.tactic_id, args.tactic_id)),
      );
    return;
  }
  await db().insert(t.mappingSuggestions).values(row);
}

/**
 * A person accepts a gap ↔ tactic mapping (an S4 proposal, or their own pick).
 * A pair S4 already committed keeps its coverage and is marked human-accepted;
 * otherwise it is assigned, with the proposal's verdict when one is given.
 */
export async function acceptMapping(args: {
  gap_id: string;
  tactic_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
  coverage?: OverallCoverage | null;
  dimensions?: Partial<Record<CoverageDimension, DimensionValue>> | null;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (!gapEligibleForMapping(gap.status)) {
    throw new Error("Only accepted open or partial gaps can receive a mapping.");
  }
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  if (!tacticEligibleForMapping(tactic)) {
    throw new Error("Only accepted, non-cancelled tactics can be mapped.");
  }
  const note = args.note?.trim() || "Accepted mapping suggestion.";
  const covered = state.coverages.some((c) => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id);
  if (covered) {
    await upsertMappingSuggestion({ ...args, status: "accepted", note });
  } else {
    await assignTacticToGap({
      gap_id: args.gap_id,
      tactic_id: args.tactic_id,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note,
      coverage: args.coverage,
      dimensions: args.dimensions,
      human: true,
    });
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "mapping",
    `${args.gap_id}::${args.tactic_id}`,
    "accept_mapping",
    `${args.tactic_id} → ${args.gap_id}`,
  );
}

export const MAPPING_ROW_STATUSES = ["open", "addressed", "partially_addressed"] as const;
export type MappingRowStatus = (typeof MAPPING_ROW_STATUSES)[number];

/**
 * A /mappings row a person saved is stored as one mapping_suggestions record
 * per gap under this reserved tactic key (`__row__:<status>`); the row's tactic
 * set is the gap's coverages, each marked human-accepted.
 */
export const HUMAN_MAPPING_ROW_PREFIX = "__row__:";

export function isMappingRowKey(tactic_id: string): boolean {
  return tactic_id.startsWith(HUMAN_MAPPING_ROW_PREFIX);
}

export type HumanMappingRow = {
  gap_id: string;
  mapping_status: MappingRowStatus;
  rationale: string;
  lock: Lock;
};

/** The row a person saved for this gap on /mappings, if any. */
export function humanMappingRow(state: IegpState, gap_id: string): HumanMappingRow | null {
  const row = state.mapping_suggestions.find((m) => m.gap_id === gap_id && isMappingRowKey(m.tactic_id));
  if (!row) return null;
  const status = row.tactic_id.slice(HUMAN_MAPPING_ROW_PREFIX.length);
  if (!(MAPPING_ROW_STATUSES as readonly string[]).includes(status)) return null;
  return {
    gap_id,
    mapping_status: status as MappingRowStatus,
    rationale: row.lock.note ?? "",
    lock: row.lock,
  };
}

/** Rejects an empty or unknown mapping status instead of casting it. */
export function requireMappingRowStatus(value: unknown): MappingRowStatus {
  if (typeof value === "string" && (MAPPING_ROW_STATUSES as readonly string[]).includes(value)) {
    return value as MappingRowStatus;
  }
  throw new Error(
    value === undefined || value === null || value === ""
      ? "Choose a mapping status (open, addressed or partially addressed) before saving this row."
      : `Unknown mapping status "${String(value)}". Use open, addressed or partially_addressed.`,
  );
}

/**
 * Saves a /mappings row as the person's decision: the gap's tactic set becomes
 * exactly `tactic_ids` (removed tactics are unassigned and recorded as rejected,
 * new ones assigned), and the row status is stored so it wins over any S4 run.
 */
export async function saveMappingTableRow(args: {
  gap_id: string;
  tactic_ids: string[];
  mapping_status: MappingRowStatus;
  actor_name: string;
  actor_function: ActorFunction;
  rationale: string;
}) {
  const mapping_status = requireMappingRowStatus(args.mapping_status);
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (!gapEligibleForMapping(gap.status)) {
    throw new Error("Only live gaps eligible for mapping can be edited here.");
  }
  const uniqueIds = [...new Set(args.tactic_ids.map((id) => id.trim()).filter(Boolean))];
  if (mapping_status !== "open" && uniqueIds.length === 0) {
    throw new Error("Addressed or partially addressed rows need at least one tactic.");
  }
  for (const tactic_id of uniqueIds) {
    const tactic = state.tactics.find((x) => x.id === tactic_id);
    if (!tactic) throw new Error(`Tactic ${tactic_id} not found`);
  }
  const current = state.coverages.filter((c) => c.gap_id === args.gap_id).map((c) => c.tactic_id);
  const removed = current.filter((id) => !uniqueIds.includes(id));
  const actor = { actor_name: args.actor_name, actor_function: args.actor_function };
  for (const tactic_id of removed) {
    await unassignTacticFromGap({ gap_id: args.gap_id, tactic_id, rationale, ...actor });
  }
  for (const tactic_id of uniqueIds) {
    if (current.includes(tactic_id)) {
      await upsertMappingSuggestion({ gap_id: args.gap_id, tactic_id, status: "accepted", ...actor, note: rationale });
    } else {
      await assignTacticToGap({ gap_id: args.gap_id, tactic_id, ...actor, note: rationale, human: true });
    }
  }
  for (const old of state.mapping_suggestions.filter((m) => m.gap_id === args.gap_id && isMappingRowKey(m.tactic_id))) {
    await db()
      .delete(t.mappingSuggestions)
      .where(and(eq(t.mappingSuggestions.gap_id, args.gap_id), eq(t.mappingSuggestions.tactic_id, old.tactic_id)));
  }
  await db().insert(t.mappingSuggestions).values({
    gap_id: args.gap_id,
    tactic_id: `${HUMAN_MAPPING_ROW_PREFIX}${mapping_status}`,
    status: "accepted",
    lock: makeLock(args.actor_name, args.actor_function, rationale),
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "mapping",
    args.gap_id,
    "save_mapping_row",
    `${mapping_status} · ${uniqueIds.join(", ") || "none"}${removed.length ? ` · removed ${removed.join(", ")}` : ""}: ${rationale}`,
  );
}

/**
 * A person rejects a gap ↔ tactic mapping. A pair already committed (by S4 or
 * anyone) is removed like unassignTacticFromGap, which needs a rationale. Either
 * way the pair is recorded as rejected, so no later model run maps it again.
 */
export async function rejectMapping(args: {
  gap_id: string;
  tactic_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  const covered = state.coverages.find(
    (c) => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id,
  );
  if (covered) {
    await unassignTacticFromGap({
      gap_id: args.gap_id,
      tactic_id: args.tactic_id,
      rationale: args.note ?? "",
      actor_name: args.actor_name,
      actor_function: args.actor_function,
    });
  } else {
    await upsertMappingSuggestion({
      ...args,
      status: "rejected",
      note: args.note || "Rejected mapping suggestion.",
    });
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "mapping",
    `${args.gap_id}::${args.tactic_id}`,
    "reject_mapping",
    `${args.tactic_id} ↛ ${args.gap_id}`,
  );
}

async function upsertResidualGapSuggestion(args: {
  parent_gap_id: string;
  statement: string;
  reasons: string[];
  status: "candidate" | "accepted" | "rejected";
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const row = {
    parent_gap_id: args.parent_gap_id,
    statement: args.statement,
    reasons: args.reasons,
    status: args.status,
    lock: makeLock(args.actor_name, args.actor_function, args.note),
  };
  const existing = state.residual_gap_suggestions.find((m) => m.parent_gap_id === args.parent_gap_id);
  if (existing) {
    await db()
      .update(t.residualGapSuggestions)
      .set({
        statement: row.statement,
        reasons: row.reasons,
        status: row.status,
        lock: row.lock,
      })
      .where(eq(t.residualGapSuggestions.parent_gap_id, args.parent_gap_id));
    return;
  }
  await db().insert(t.residualGapSuggestions).values(row);
}

async function consumeResidualRecord(args: {
  gap_id: string;
  statement: string;
  domain: EvidenceDomain;
  rationale: string;
  review_status: "candidate" | "accepted" | "rejected";
  created_gap_id: string | null;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const existing = state.residuals.find((row) => row.gap_id === args.gap_id);
  const lock =
    args.review_status === "candidate"
      ? existing?.lock.locked
        ? existing.lock
        : unlocked()
      : makeLock(args.actor_name, args.actor_function, args.note);
  const row = {
    statement: args.statement,
    domain: args.domain,
    draft_rationale: args.rationale || existing?.draft_rationale || "",
    review_status: args.review_status,
    created_gap_id: args.created_gap_id,
    lock,
  };
  if (existing) {
    if (
      (existing.review_status === "accepted" || existing.review_status === "rejected") &&
      args.review_status === "candidate"
    ) {
      return;
    }
    await db().update(t.residuals).set(row).where(eq(t.residuals.id, existing.id));
    return;
  }
  await db().insert(t.residuals).values({
    id: nextId(
      "RES",
      state.residuals.map((r) => r.id),
    ),
    gap_id: args.gap_id,
    ...row,
  });
}

/** Leftover rows a human has saved and not yet accepted or rejected. */
export async function listResidualGapDrafts() {
  return persistedResidualGaps(await loadState());
}

function savedResidualDraft(state: IegpState, parent_gap_id: string) {
  return state.residual_gap_suggestions.find(
    (row) => row.parent_gap_id === parent_gap_id && row.status === "candidate",
  );
}

export async function acceptResidualGap(args: {
  parent_gap_id: string;
  statement?: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const parent = state.gaps.find((g) => g.id === args.parent_gap_id);
  if (!parent) throw new Error("Parent gap not found");
  const rejected = state.residual_gap_suggestions.find(
    (row) => row.parent_gap_id === args.parent_gap_id && row.status === "rejected",
  );
  if (rejected) {
    throw new Error("That leftover was rejected. It will not be suggested again.");
  }
  if (state.gaps.some((g) => g.parent_gap_id === args.parent_gap_id)) {
    throw new Error("A child gap already exists for this leftover.");
  }
  const saved = savedResidualDraft(state, args.parent_gap_id);
  if (!saved && !args.statement?.trim()) {
    throw new Error("No leftover residual to accept.");
  }
  const statement = (args.statement || saved?.statement || "").trim();
  if (!statement) throw new Error("Statement is required.");
  const childId = await createGap({
    statement,
    domain: parent.domain,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Accepted leftover as a new Open gap. Parent statement preserved.",
    parent_gap_id: args.parent_gap_id,
  });
  if (parent.status !== "validated_addressed" && parent.status !== "excluded") {
    await lockGapStatus({
      gap_id: args.parent_gap_id,
      status: "validated_addressed",
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note:
        args.note ||
        "Human split: covered portion locked as Addressed. Residual accepted as a new Open gap. Parent statement preserved.",
    });
  }
  await upsertResidualGapSuggestion({
    parent_gap_id: args.parent_gap_id,
    statement,
    reasons: saved?.reasons ?? ["Human accepted residual as a new gap."],
    status: "accepted",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Accepted leftover as a new gap.",
  });
  await consumeResidualRecord({
    gap_id: args.parent_gap_id,
    statement,
    domain: parent.domain,
    rationale: (saved?.reasons ?? []).join(" "),
    review_status: "accepted",
    created_gap_id: childId,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Accepted leftover as a new gap.",
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "residual_gap",
    args.parent_gap_id,
    "accept_residual_gap",
    `${args.parent_gap_id} → ${childId}`,
  );
  await recordResidualEdit(args, "accept", saved?.statement ?? null, `${childId}: ${statement}`);
  return childId;
}

/** Leftover decisions carry the reviewer's note as the edit rationale when there is one. */
async function recordResidualEdit(
  args: { parent_gap_id: string; actor_name: string; actor_function: ActorFunction; note?: string },
  action: "accept" | "edit" | "reject",
  before: string | null,
  after: string | null,
) {
  const rationale = args.note?.trim() ?? "";
  if (rationale.length < 3) return;
  await recordEdit({
    stage: "S6",
    entity_type: "residual_gap",
    entity_id: args.parent_gap_id,
    field: "leftover",
    action,
    before,
    after,
    rationale,
    actor: { name: args.actor_name, function: args.actor_function },
  });
}

export async function modifyResidualGap(args: {
  parent_gap_id: string;
  statement: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const statement = args.statement.trim();
  if (!statement) throw new Error("Statement is required.");
  const state = await loadState();
  const parent = state.gaps.find((g) => g.id === args.parent_gap_id);
  if (!parent) throw new Error("Parent gap not found");
  const existing = state.residual_gap_suggestions.find((row) => row.parent_gap_id === args.parent_gap_id);
  if (existing?.status === "accepted" || existing?.status === "rejected") {
    throw new Error("That leftover is already locked.");
  }
  await upsertResidualGapSuggestion({
    parent_gap_id: args.parent_gap_id,
    statement,
    reasons: existing?.reasons ?? ["Human modified the leftover statement."],
    status: "candidate",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Modified residual statement.",
  });
  await consumeResidualRecord({
    gap_id: args.parent_gap_id,
    statement,
    domain: parent.domain,
    rationale: (existing?.reasons ?? ["Human modified the leftover statement."]).join(" "),
    review_status: "candidate",
    created_gap_id: null,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Modified residual statement.",
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "residual_gap",
    args.parent_gap_id,
    "modify_residual_gap",
    statement.slice(0, 180),
  );
  await recordResidualEdit(args, "edit", existing?.statement ?? null, statement);
}

export async function rejectResidualGap(args: {
  parent_gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const parent = state.gaps.find((g) => g.id === args.parent_gap_id);
  if (!parent) throw new Error("Parent gap not found");
  if (state.gaps.some((g) => g.parent_gap_id === args.parent_gap_id)) {
    throw new Error("A child gap already exists for this leftover.");
  }
  const saved = savedResidualDraft(state, args.parent_gap_id);
  await upsertResidualGapSuggestion({
    parent_gap_id: args.parent_gap_id,
    statement: saved?.statement ?? parent.statement,
    reasons: saved?.reasons ?? ["Human rejected this leftover."],
    status: "rejected",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Rejected leftover-as-new-gap suggestion.",
  });
  await consumeResidualRecord({
    gap_id: args.parent_gap_id,
    statement: saved?.statement ?? parent.statement,
    domain: parent.domain,
    rationale: (saved?.reasons ?? ["Human rejected this leftover."]).join(" "),
    review_status: "rejected",
    created_gap_id: null,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Rejected leftover-as-new-gap suggestion.",
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "residual_gap",
    args.parent_gap_id,
    "reject_residual_gap",
    `${args.parent_gap_id} leftover suppressed`,
  );
  await recordResidualEdit(args, "reject", saved?.statement ?? null, null);
}

export async function createGap(args: {
  name?: string;
  statement: string;
  domain?: EvidenceDomain;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
  parent_gap_id?: string | null;
  settings?: string[];
  /** An existing need to become this gap's primary need (a need moved out of another gap). */
  need_id?: string;
  /** Provenance for a gap promoted from a rejected S2 candidate: its source and quote. */
  source_id?: string;
  source_quote?: string;
}) {
  const statement = args.statement.trim();
  if (!statement) throw new Error("Statement is required.");
  const domain = args.domain && EVIDENCE_DOMAINS.includes(args.domain) ? args.domain : "unmet_need";
  const state = await loadState();
  const obj = state.objectives[0];
  if (!obj) throw new Error("No strategic objective to attach this gap to.");
  // Split and rewrite children carry the parent's settings through.
  let settings = normalizeSettings(args.settings ?? []);
  if (args.parent_gap_id) {
    const parent = state.gaps.find((g) => g.id === args.parent_gap_id);
    if (!parent) throw new Error("Parent gap not found");
    if (!args.settings) settings = parent.settings;
  }
  const name = args.name?.trim() || gapNameFromStatement(statement);
  const id = nextId(
    "GAP",
    state.gaps.map((g) => g.id),
  );
  await db().insert(t.gaps).values({
    id,
    name,
    statement,
    domain,
    objective_id: obj.id,
    status: "validated_open",
    exclusion_reason: null,
    exclusion_note: null,
    lock: makeLock(args.actor_name, args.actor_function, args.note),
    parent_gap_id: args.parent_gap_id ?? null,
    computed_status: "validated_open",
    status_override: null,
    retired: false,
    human_validated: false,
    parked_at: null,
    parked_reason: null,
    settings,
  });
  await appendAudit(args.actor_name, args.actor_function, "gap", id, "create", name);
  if (args.need_id) {
    await linkNeedOntoGap(args.need_id, id, "primary");
  } else if (args.source_id && state.sources.some((s) => s.id === args.source_id)) {
    await insertNeedForGap({
      gapId: id,
      sourceId: args.source_id,
      statement,
      sourceQuote: args.source_quote?.trim() || statement,
      role: "primary",
      actor_function: args.actor_function,
    });
  }
  await syncComputedGapStatuses(id);
  if (args.parent_gap_id) await syncComputedGapStatuses(args.parent_gap_id);
  await ensureGapHasConstituentNeed(id);
  return id;
}

/**
 * Human edit of a gap's name, statement and domain. Rationale is required; each
 * changed field is filed as an edit record with its before and after value, and
 * the gap is locked to the editor. No stage rewrites an existing gap's text: S2
 * re-runs only add needs onto a gap they judge a duplicate.
 */
export async function modifyGap(args: {
  gap_id: string;
  name?: string;
  statement?: string;
  domain?: EvidenceDomain | string;
  rationale?: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const rationale = requireRationale(args.rationale ?? args.note);
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (gap.retired) throw new Error("This gap was retired by a split or rewrite. Edit the live gap.");
  const name = args.name === undefined ? undefined : args.name.trim();
  const statement = args.statement === undefined ? undefined : args.statement.trim();
  if (name !== undefined && !name) throw new Error("Gap name is required.");
  if (statement !== undefined && !statement) throw new Error("Statement is required.");
  const domain = args.domain === undefined || args.domain === "" ? undefined : args.domain;
  if (domain !== undefined && !EVIDENCE_DOMAINS.includes(domain as EvidenceDomain)) {
    throw new Error("Unknown evidence domain.");
  }
  const changes = diffFields(gap, { name, statement, domain });
  if (changes.length === 0) throw new Error("Nothing changed.");
  await db()
    .update(t.gaps)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(statement !== undefined ? { statement } : {}),
      ...(domain !== undefined ? { domain: domain as EvidenceDomain } : {}),
      lock: makeLock(args.actor_name, args.actor_function, rationale),
    })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "modify",
    `${changes.map((c) => c.field).join(", ")}: ${rationale}`,
  );
  await recordFieldEdits({
    stage: "S2",
    entity_type: "gap",
    entity_id: args.gap_id,
    changes,
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  return changes;
}

export async function lockTactic(args: {
  tactic_id: string;
  status: IegpState["tactics"][0]["status"];
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  const prev = tactic.status;
  await db()
    .update(t.tactics)
    .set({
      status: args.status,
      lock: makeLock(args.actor_name, args.actor_function, args.note),
    })
    .where(eq(t.tactics.id, args.tactic_id));
  if (prev !== args.status) {
    // Reload after the status write so sync sees planned/ongoing/completed on this connection.
    const fresh = await loadState();
    const related = fresh.coverages.filter((c) => c.tactic_id === args.tactic_id);
    for (const c of related) {
      const residuals = fresh.residuals.filter((r) => r.gap_id === c.gap_id);
      for (const r of residuals) {
        await db()
          .update(t.residuals)
          .set({ lock: unlocked() })
          .where(eq(t.residuals.id, r.id));
      }
    }
    for (const c of related) {
      await syncComputedGapStatuses(c.gap_id);
    }
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "tactic",
    args.tactic_id,
    "lock_status",
    `${prev} → ${args.status}`,
  );
}

export async function lockRoadmapItem(args: {
  tactic_id: string;
  residual_ids: string[];
  start_date: string | null;
  evidence_available: string | null;
  owner: string;
  note?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  if (tactic.status === "completed") {
    throw new Error("Completed tactics stay on the dossier, not the forward roadmap.");
  }
  const existing = state.roadmap.find((r) => r.tactic_id === args.tactic_id);
  const row = {
    tactic_id: args.tactic_id,
    residual_ids: args.residual_ids,
    start_date: args.start_date,
    evidence_available: args.evidence_available,
    owner: args.owner,
    note: args.note ?? null,
    lock: makeLock(args.actor_name, args.actor_function, args.note),
  };
  if (existing) {
    await db().update(t.roadmap).set(row).where(eq(t.roadmap.id, existing.id));
  } else {
    await db().insert(t.roadmap).values({
      id: nextId("RM", state.roadmap.map((r) => r.id)),
      ...row,
    });
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "roadmap",
    args.tactic_id,
    "lock_item",
    tactic.name,
  );
}

/**
 * S1 output: the domain source document and its blocks, with no extraction. The
 * modular parse stage stops here; extraction stages commit against `source_id`.
 */
export async function persistSourceAndBlocks(args: {
  title: string;
  source_type: IegpState["sources"][0]["source_type"];
  stakeholder_function: ActorFunction;
  text: string;
  filename?: string;
  /**
   * Blocks the parse LLM already decided. When omitted (test stub, typed
   * notes) the text is split mechanically.
   */
  sections?: { heading: string; text: string; location: string }[];
}): Promise<{ source_id: string; blocks: IegpState["blocks"] }> {
  const state = await loadState();
  const sourceId = nextId("SRC", state.sources.map((s) => s.id));
  await db().insert(t.sources).values({
    id: sourceId,
    filename: args.filename ?? args.title.replaceAll(" ", "_") + ".txt",
    title: args.title,
    source_type: args.source_type,
    stakeholder_function: args.stakeholder_function,
    ingested_at: now(),
    full_text: args.text,
  });
  const sections =
    args.sections ??
    splitSourceIntoBlocks(args.text, args.title).map((section) => ({
      ...section,
      location: section.heading === "Note" ? "Uploaded note" : section.heading,
    }));
  const blocks = sections.map((section, i) => ({
    id: `${sourceId}-B${String(i + 1).padStart(2, "0")}`,
    source_id: sourceId,
    heading: section.heading,
    text: section.text,
    location: section.location,
  }));
  if (blocks.length) await db().insert(t.sourceBlocks).values(blocks);
  return { source_id: sourceId, blocks };
}

export type CandidateNeedRow = {
  id: string;
  statement: string;
  source_quote: string;
  /**
   * Explicit link to an existing live gap. Without it, the need belongs to the
   * gap row in the same commit that carries the same candidate `id`.
   */
  gap_id?: string | null;
};

/**
 * Commits a judged candidate set against an existing source. The S2/S3 LLM
 * stages decide what the set is and which rows repeat an existing record; this
 * function only persists those decisions:
 * - a gap with `duplicate_of` joins that live gap (its need is linked there);
 *   otherwise it is inserted as a new gap. An unknown id throws.
 * - a need links to the gap named by `gap_id`, or to the gap row with its
 *   candidate id. A need with neither throws: nothing is linked by similarity.
 * - a tactic with `duplicate_of` is skipped (the id must exist); otherwise it is
 *   inserted. Only rows the S3 judge accepted are passed here, so they are
 *   stored accepted as that judge's decision unless a row says `candidate`.
 * Mapping is S4's job and leftovers are S6's: neither happens here.
 */
export async function commitExtractedRecords(args: {
  source_id: string;
  title: string;
  stakeholder_function: ActorFunction;
  actor_name: string;
  actor_function: ActorFunction;
  needs: CandidateNeedRow[];
  gaps: ExtractedGap[];
  tactics: ExtractedTactic[];
  /** @deprecated Ignored. Mapping runs only as S4. */
  apply_mappings?: boolean;
}): Promise<{
  need_ids: string[];
  gap_ids: string[];
  tactic_ids: string[];
  merged_gap_ids: string[];
  skipped_tactic_ids: string[];
}> {
  const state = await loadState();
  const sourceId = args.source_id;
  const obj = state.objectives[0];
  if (!obj) throw new Error("No strategic objective to attach these records to.");
  if (!state.sources.some((s) => s.id === sourceId)) {
    throw new Error(`Source ${sourceId} not found. Nothing was saved.`);
  }

  // Validate every judged reference before writing anything.
  const liveGaps = new Map(state.gaps.filter(isLiveGap).map((g) => [g.id, g]));
  // A repeat of a gap a person excluded or parked joins that gap as provenance
  // and leaves it excluded or parked: a re-run never re-opens a human decision.
  const setAsideGaps = new Map(
    state.gaps
      .filter((g) => !g.retired && (g.status === "excluded" || Boolean(g.parked_at)))
      .map((g) => [g.id, g]),
  );
  const tacticIdsKnown = new Set(state.tactics.map((x) => x.id));
  const gapRows = new Map(args.gaps.map((g) => [g.id, g]));
  for (const gap of args.gaps) {
    if (gap.duplicate_of && !liveGaps.has(gap.duplicate_of) && !setAsideGaps.has(gap.duplicate_of)) {
      throw new Error(
        `Gap candidate ${gap.id} is marked a duplicate of ${gap.duplicate_of}, which is not a live gap (nor an excluded or parked one). Nothing was saved.`,
      );
    }
  }
  for (const tac of args.tactics) {
    if (tac.duplicate_of && !tacticIdsKnown.has(tac.duplicate_of)) {
      throw new Error(
        `Tactic candidate ${tac.id} is marked a duplicate of ${tac.duplicate_of}, which is not a known tactic. Nothing was saved.`,
      );
    }
  }
  const needByGapRow = new Map<string, CandidateNeedRow>();
  const needsOnExistingGaps: CandidateNeedRow[] = [];
  for (const need of args.needs) {
    if (need.gap_id) {
      if (!liveGaps.has(need.gap_id)) {
        throw new Error(`Need candidate ${need.id} links to ${need.gap_id}, which is not a live gap. Nothing was saved.`);
      }
      needsOnExistingGaps.push(need);
    } else if (gapRows.has(need.id)) {
      needByGapRow.set(need.id, need);
    } else {
      throw new Error(
        `Need candidate ${need.id} has no gap: give it gap_id or commit it with the gap row of the same id. Nothing was saved.`,
      );
    }
  }

  const needIds = state.needs.map((n) => n.id);
  const hasPrimary = new Set(
    state.need_gap_links.filter((l) => l.role === "primary").map((l) => l.gap_id),
  );
  const createdNeedIds: string[] = [];
  const createdGapIds: string[] = [];
  const mergedGapIds: string[] = [];

  const addNeed = async (args2: {
    gapId: string;
    statement: string;
    quote: string;
    domain: EvidenceDomain;
  }) => {
    const needId = nextId("NEED", needIds);
    needIds.push(needId);
    createdNeedIds.push(needId);
    await insertNeedRow({
      id: needId,
      statement: args2.statement,
      source_quote: args2.quote,
      domain: args2.domain,
      stakeholder: args.stakeholder_function,
      source_id: sourceId,
      objective: obj,
      geography: state.asset.geography,
    });
    const role = hasPrimary.has(args2.gapId) ? "supporting" : "primary";
    hasPrimary.add(args2.gapId);
    await linkNeedOntoGap(needId, args2.gapId, role);
  };

  for (const gapRow of args.gaps) {
    let gapId: string;
    if (gapRow.duplicate_of) {
      gapId = gapRow.duplicate_of;
      mergedGapIds.push(gapId);
    } else {
      gapId = await insertLiveOpenGap({
        name: gapRow.name,
        statement: gapRow.statement,
        domain: gapRow.domain,
        objectiveId: obj.id,
      });
      createdGapIds.push(gapId);
    }
    const need = needByGapRow.get(gapRow.id);
    await addNeed({
      gapId,
      statement: need?.statement ?? gapRow.statement,
      quote: need?.source_quote ?? gapRow.source_quote,
      domain: gapRow.domain,
    });
  }
  for (const need of needsOnExistingGaps) {
    const gap = liveGaps.get(need.gap_id!)!;
    await addNeed({
      gapId: gap.id,
      statement: need.statement,
      quote: need.source_quote,
      domain: gap.domain,
    });
  }

  const tacticIds = state.tactics.map((x) => x.id);
  const createdTacticIds: string[] = [];
  const skippedTacticIds: string[] = [];
  for (const tac of args.tactics) {
    if (tac.duplicate_of) {
      skippedTacticIds.push(tac.id);
      continue;
    }
    const tacticId = nextId("TAC", tacticIds);
    tacticIds.push(tacticId);
    createdTacticIds.push(tacticId);
    await db().insert(t.tactics).values({
      id: tacticId,
      name: tac.name,
      type: tac.type,
      description: `Extracted from ${args.title}. Inventory from the source, not ideation.`,
      evidence_question: tac.evidence_question,
      population: "",
      intervention: "",
      comparator: "",
      outcomes: "",
      geography: state.asset.geography,
      data_source: args.title,
      study_design: "",
      lifecycle_stage: "extracted",
      status: tac.status,
      review_status: tac.review_status ?? "accepted",
      start_date: null,
      evidence_available: null,
      owner: args.actor_name,
      function: args.actor_function,
      budget: null,
      intended_use: `Extracted from ${sourceId}`,
      lock: unlocked(),
      source_quote: (tac.source_quote ?? "").trim(),
    });
  }

  await appendAudit(
    args.actor_name,
    args.actor_function,
    "source",
    sourceId,
    "ingest",
    `Committed ${args.title}; ${createdNeedIds.length} need(s), ${createdGapIds.length} new gap(s), ${mergedGapIds.length} joined as duplicates, ${createdTacticIds.length} tactic(s), ${skippedTacticIds.length} duplicate tactic(s) skipped.`,
  );
  await syncComputedGapStatuses();
  return {
    need_ids: createdNeedIds,
    gap_ids: createdGapIds,
    tactic_ids: createdTacticIds,
    merged_gap_ids: mergedGapIds,
    skipped_tactic_ids: skippedTacticIds,
  };
}

export async function lockTacticReview(args: {
  tactic_id: string;
  review_status: "accepted" | "rejected";
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  if (args.review_status === "rejected" && !args.note?.trim()) {
    throw new Error("Rejecting a tactic requires a note.");
  }
  await db()
    .update(t.tactics)
    .set({
      review_status: args.review_status,
      lock: makeLock(args.actor_name, args.actor_function, args.note),
    })
    .where(eq(t.tactics.id, args.tactic_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "tactic",
    args.tactic_id,
    "lock_review",
    `${tactic.review_status} → ${args.review_status}`,
  );
  const rationale = args.note?.trim() ?? "";
  if (rationale.length >= 3) {
    await recordEdit({
      stage: "S3",
      entity_type: "tactic",
      entity_id: args.tactic_id,
      field: "review_status",
      action: args.review_status === "accepted" ? "accept" : "reject",
      before: tactic.review_status,
      after: args.review_status,
      rationale,
      actor: { name: args.actor_name, function: args.actor_function },
    });
  }
}

/** Tactic fields a person can edit on /tactics/[id]. Dates are YYYY-MM or YYYY-MM-DD, or blank. */
export const TACTIC_EDIT_FIELDS = [
  "name",
  "type",
  "evidence_question",
  "population",
  "intervention",
  "comparator",
  "outcomes",
  "study_design",
  "data_source",
  "geography",
  "start_date",
  "evidence_available",
] as const;
export type TacticEditField = (typeof TACTIC_EDIT_FIELDS)[number];

const TACTIC_DATE_FIELDS = new Set<TacticEditField>(["start_date", "evidence_available"]);

/**
 * Human edit of a tactic. Only the fields the caller names change; rationale is
 * required, each change is filed as an edit record with before/after, and the
 * tactic is locked to the editor. No stage rewrites an existing tactic (S3 skips
 * a repeat as `duplicate_of`), so human values, dates included, survive re-runs.
 */
export async function modifyTactic(args: {
  tactic_id: string;
  fields?: Partial<Record<TacticEditField, string | null>>;
  /** Legacy shape: name and evidence question at the top level. */
  name?: string;
  evidence_question?: string;
  rationale?: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const rationale = requireRationale(args.rationale ?? args.note);
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  const draft: Partial<Record<TacticEditField, string | null>> = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.evidence_question !== undefined ? { evidence_question: args.evidence_question } : {}),
    ...(args.fields ?? {}),
  };
  const clean: Record<string, string | null> = {};
  for (const field of TACTIC_EDIT_FIELDS) {
    const raw = draft[field];
    if (raw === undefined) continue;
    const value = (raw ?? "").trim();
    if (TACTIC_DATE_FIELDS.has(field)) {
      if (value && !/^\d{4}-\d{2}(-\d{2})?$/.test(value)) {
        throw new Error(`${field.replace("_", " ")} must be a date (YYYY-MM-DD) or blank.`);
      }
      clean[field] = value || null;
      continue;
    }
    if ((field === "name" || field === "evidence_question") && !value) {
      throw new Error(field === "name" ? "Tactic name is required." : "Evidence question is required.");
    }
    if (field === "type" && !TACTIC_TYPES.includes(value as IegpState["tactics"][0]["type"])) {
      throw new Error("Tactic type is required.");
    }
    clean[field] = value;
  }
  const changes = diffFields(tactic, clean);
  if (changes.length === 0) throw new Error("Nothing changed.");
  const set: Record<string, string | null> = {};
  for (const change of changes) set[change.field] = change.after;
  await db()
    .update(t.tactics)
    .set({ ...set, lock: makeLock(args.actor_name, args.actor_function, rationale) })
    .where(eq(t.tactics.id, args.tactic_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "tactic",
    args.tactic_id,
    "modify",
    `${changes.map((c) => c.field).join(", ")}: ${rationale}`,
  );
  await recordFieldEdits({
    stage: "S3",
    entity_type: "tactic",
    entity_id: args.tactic_id,
    changes,
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  if (changes.some((c) => c.field === "type")) {
    // Coverage status depends on tactic type; recompute the gaps this tactic maps to.
    const gapIds = new Set(state.coverages.filter((c) => c.tactic_id === args.tactic_id).map((c) => c.gap_id));
    for (const gapId of gapIds) await syncComputedGapStatuses(gapId);
  }
  return changes;
}

export async function saveProductSetup(args: {
  context: PlanningContext;
  actor_name: string;
  actor_function: ActorFunction;
  mark_complete?: boolean;
}) {
  const state = await loadState();
  const ctx = parsePlanningContext(args.context);
  await db()
    .update(t.assets)
    .set({
      name: ctx.asset_name || state.asset.name,
      inn: ctx.inn || state.asset.inn,
      indication: ctx.indication || state.asset.indication,
      geography: ctx.geography || state.asset.geography,
      planning_context: ctx,
      setup_complete: args.mark_complete ?? false,
    })
    .where(eq(t.assets.id, state.asset.id));
  if (state.objectives[0]) {
    await db()
      .update(t.objectives)
      .set({
        indication: ctx.indication || state.objectives[0].indication,
        geography: ctx.geography || state.objectives[0].geography,
        lifecycle_stage: ctx.lifecycle_stage || state.objectives[0].lifecycle_stage,
        strategic_importance: ctx.strategic_importance,
        key_decision: ctx.key_decision || state.objectives[0].key_decision,
        decision_date: ctx.decision_date || state.objectives[0].decision_date,
      })
      .where(eq(t.objectives.id, state.objectives[0].id));
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "plan",
    state.asset.id,
    args.mark_complete ? "complete_setup" : "save_setup",
    args.mark_complete
      ? "Product setup wizard complete."
      : "Saved asset and planning context from setup wizard.",
  );
}

export async function completeWizard(args: {
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  if (state.sources.length === 0) {
    throw new Error("Ingest at least one source before entering the plan.");
  }
  if (!gapsReadyForPrioritize(state)) {
    throw new Error(
      "Validate every live gap first. Partially Addressed gaps must be split or rewritten — they cannot stay.",
    );
  }
  await db()
    .update(t.assets)
    .set({ wizard_complete: true })
    .where(eq(t.assets.id, state.asset.id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "plan",
    state.asset.id,
    "complete_wizard",
    args.note || "Wizard complete. Living on the plan from here.",
  );
}

export async function unlockTacticsStage(args: {
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  if (!state.asset.wizard_complete) {
    throw new Error("Prioritize open gaps before tactics.");
  }
  await db()
    .update(t.assets)
    .set({ tactics_unlocked: true })
    .where(eq(t.assets.id, state.asset.id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "plan",
    state.asset.id,
    "unlock_tactics",
    args.note || "Tactics stage unlocked for open gaps.",
  );
}

async function insertGapVersion(args: {
  live_gap_id: string;
  retired_gap_id: string;
  snapshot: IegpState["gaps"][0];
  event: IegpState["gap_versions"][0]["event"];
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const id = nextId(
    "GV",
    state.gap_versions.map((row) => row.id),
  );
  await db().insert(t.gapVersions).values({
    id,
    live_gap_id: args.live_gap_id,
    retired_gap_id: args.retired_gap_id,
    name: args.snapshot.name,
    statement: args.snapshot.statement,
    status: args.snapshot.status,
    domain: args.snapshot.domain,
    event: args.event,
    at: now(),
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
}

async function retireGap(gap_id: string) {
  await db()
    .update(t.gaps)
    .set({
      retired: true,
      human_validated: true,
      lock: unlocked(),
    })
    .where(eq(t.gaps.id, gap_id));
}

async function insertClosingCoverage(args: {
  gap_id: string;
  tactic_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note: string;
}) {
  const state = await loadState();
  const existing = state.coverages.find(
    (c) => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id,
  );
  if (existing) {
    await db()
      .update(t.coverages)
      .set({
        overall: "full",
        overall_rationale: args.note,
        overall_lock: makeLock(args.actor_name, args.actor_function, args.note),
        stale: false,
        needs_review: false,
      })
      .where(eq(t.coverages.id, existing.id));
    return;
  }
  const coverageId = nextId(
    "COV",
    state.coverages.map((c) => c.id),
  );
  await db().insert(t.coverages).values({
    id: coverageId,
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    dimensions: emptyDimensions(),
    overall: "full",
    overall_rationale: args.note,
    overall_lock: makeLock(args.actor_name, args.actor_function, args.note),
    stale: false,
    needs_review: false,
  });
}

export async function validateGap(args: {
  gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap || !isLiveGap(gap)) throw new Error("Gap not found");
  const shown = displayedGapStatus(gap);
  if (shown === "validated_partial") {
    throw new Error("Partially Addressed cannot stay. Split or rewrite this gap first.");
  }
  if (shown !== "validated_open" && shown !== "validated_addressed") {
    throw new Error("Only Open or Addressed gaps can be validated.");
  }
  await db()
    .update(t.gaps)
    .set({
      human_validated: true,
      lock: makeLock(args.actor_name, args.actor_function, args.note),
    })
    .where(eq(t.gaps.id, args.gap_id));
  if (shown === "validated_open") {
    await ensurePriorityResidual(args.gap_id, args.actor_name, args.actor_function);
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "validate",
    args.note || `Validated ${shown}`,
  );
}

async function ensurePriorityResidual(
  gap_id: string,
  actor_name: string,
  actor_function: ActorFunction,
) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === gap_id);
  if (!gap) return;
  if (state.residuals.some((r) => r.gap_id === gap_id)) return;
  await db().insert(t.residuals).values({
    id: nextId(
      "RES",
      state.residuals.map((r) => r.id),
    ),
    gap_id,
    statement: gap.name,
    domain: gap.domain,
    draft_rationale: "Open gap queued for priority.",
    review_status: "accepted",
    created_gap_id: null,
    lock: makeLock(actor_name, actor_function, "Open gap ready to prioritize."),
  });
}

function uniqueIds(ids?: (string | undefined | null)[] | null): string[] {
  return [...new Set((ids ?? []).map((id) => (id ?? "").trim()).filter(Boolean))];
}

export async function splitPartialGap(args: {
  parent_gap_id: string;
  addressed_name: string;
  addressed_statement?: string;
  open_name: string;
  open_statement?: string;
  tactic_id?: string;
  tactic_ids?: string[];
  open_tactic_ids?: string[];
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const addressed_name = args.addressed_name.trim();
  const open_name = args.open_name.trim();
  const addressed_statement = (args.addressed_statement ?? addressed_name).trim();
  const open_statement = (args.open_statement ?? open_name).trim();
  if (!addressed_name || !open_name) throw new Error("Both split titles are required.");
  if (!addressed_statement || !open_statement) throw new Error("Both split statements are required.");
  const addressedTacticIds = uniqueIds([...(args.tactic_ids ?? []), args.tactic_id]);
  if (addressedTacticIds.length === 0) {
    throw new Error("Select at least one tactic that addresses the closed slice.");
  }
  const state = await loadState();
  const parent = state.gaps.find((g) => g.id === args.parent_gap_id);
  if (!parent || !isLiveGap(parent)) throw new Error("Gap not found");
  if (displayedGapStatus(parent) !== "validated_partial") {
    throw new Error("Only Partially Addressed gaps can split.");
  }
  for (const tacticId of addressedTacticIds) {
    if (!state.tactics.find((x) => x.id === tacticId)) {
      throw new Error("Select the tactic that addresses the closed slice.");
    }
  }
  const addressedId = await createGap({
    name: addressed_name,
    statement: addressed_statement,
    domain: parent.domain,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: "Split: addressed slice.",
    parent_gap_id: parent.id,
  });
  const openId = await createGap({
    name: open_name,
    statement: open_statement,
    domain: parent.domain,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: "Split: residual open leftover.",
    parent_gap_id: parent.id,
  });
  await copyNeedGapLinks(parent.id, addressedId);
  await copyNeedGapLinks(parent.id, openId);
  await ensureGapHasConstituentNeed(addressedId);
  await ensureGapHasConstituentNeed(openId);
  for (const tacticId of addressedTacticIds) {
    await insertClosingCoverage({
      gap_id: addressedId,
      tactic_id: tacticId,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: "Split: this tactic closes the addressed slice.",
    });
  }
  const addressedSet = new Set(addressedTacticIds);
  const leftoverIds = uniqueIds(args.open_tactic_ids).filter((id) => !addressedSet.has(id));
  for (const tacticId of leftoverIds) {
    const tactic = (await loadState()).tactics.find((x) => x.id === tacticId);
    if (!tactic) continue;
    await assignTacticToGap({
      gap_id: openId,
      tactic_id: tacticId,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: "Split: leftover tactic mapped to the open child.",
    });
  }
  await syncComputedGapStatuses(addressedId);
  await db()
    .update(t.gaps)
    .set({
      status: "validated_addressed",
      computed_status: "validated_addressed",
      human_validated: true,
      lock: makeLock(args.actor_name, args.actor_function, "Split addressed slice."),
    })
    .where(eq(t.gaps.id, addressedId));
  await db()
    .update(t.gaps)
    .set({
      status: "validated_open",
      computed_status: "validated_open",
      human_validated: true,
      lock: makeLock(args.actor_name, args.actor_function, "Split open leftover."),
    })
    .where(eq(t.gaps.id, openId));
  await ensurePriorityResidual(openId, args.actor_name, args.actor_function);
  await insertGapVersion({
    live_gap_id: addressedId,
    retired_gap_id: parent.id,
    snapshot: parent,
    event: "split",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  await insertGapVersion({
    live_gap_id: openId,
    retired_gap_id: parent.id,
    snapshot: parent,
    event: "split",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  await retireGap(parent.id);
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    parent.id,
    "split",
    `${parent.id} → addressed ${addressedId}, open ${openId}`,
  );
  return { addressedId, openId };
}

export async function rewritePartialGap(args: {
  gap_id: string;
  name: string;
  statement?: string;
  status: "validated_open" | "validated_addressed";
  tactic_id?: string;
  tactic_ids?: string[];
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const name = args.name.trim();
  const statement = (args.statement ?? name).trim();
  if (!name) throw new Error("Rewritten gap title is required.");
  if (!statement) throw new Error("Rewritten gap statement is required.");
  const tacticIds = uniqueIds([...(args.tactic_ids ?? []), args.tactic_id]);
  if (args.status === "validated_addressed" && tacticIds.length === 0) {
    throw new Error("Addressed gaps need an accompanying tactic.");
  }
  const state = await loadState();
  const original = state.gaps.find((g) => g.id === args.gap_id);
  if (!original || !isLiveGap(original)) throw new Error("Gap not found");
  if (displayedGapStatus(original) !== "validated_partial") {
    throw new Error("Only Partially Addressed gaps can be rewritten this way.");
  }
  const liveId = await createGap({
    name,
    statement,
    domain: original.domain,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Rewritten from a Partially Addressed gap. Original retired to history.",
    parent_gap_id: original.id,
  });
  await copyNeedGapLinks(original.id, liveId);
  await ensureGapHasConstituentNeed(liveId);
  if (args.status === "validated_addressed") {
    for (const tacticId of tacticIds) {
      await insertClosingCoverage({
        gap_id: liveId,
        tactic_id: tacticId,
        actor_name: args.actor_name,
        actor_function: args.actor_function,
        note: "Rewritten as Addressed with this tactic.",
      });
    }
  }
  await syncComputedGapStatuses(liveId);
  await db()
    .update(t.gaps)
    .set({
      status: args.status,
      computed_status: args.status,
      human_validated: true,
      lock: makeLock(args.actor_name, args.actor_function, args.note),
    })
    .where(eq(t.gaps.id, liveId));
  if (args.status === "validated_open") {
    await ensurePriorityResidual(liveId, args.actor_name, args.actor_function);
  }
  await insertGapVersion({
    live_gap_id: liveId,
    retired_gap_id: original.id,
    snapshot: original,
    event: "rewrite",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  await retireGap(original.id);
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    original.id,
    "rewrite",
    `${original.id} → ${liveId} (${args.status})`,
  );
  return liveId;
}

export async function createAddressedGap(args: {
  name?: string;
  statement: string;
  domain?: EvidenceDomain;
  tactic_id?: string;
  missed_name?: string;
  missed_type?: IegpState["tactics"][0]["type"];
  missed_status?: string;
  missed_evidence_question?: string;
  missed_description?: string;
  catch_up_reason?: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  let tacticId = args.tactic_id?.trim();
  if (!tacticId) {
    if (!args.missed_name?.trim()) {
      throw new Error("Addressed gaps need an accompanying tactic.");
    }
    tacticId = await recordMissedTactic({
      name: args.missed_name,
      type: args.missed_type || "rwe_study",
      description: args.missed_description,
      evidence_question: args.missed_evidence_question || args.statement,
      status: args.missed_status || "",
      catch_up_reason: args.catch_up_reason,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
    });
  }
  const id = await createGap({
    name: args.name,
    statement: args.statement,
    domain: args.domain,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note,
  });
  await insertClosingCoverage({
    gap_id: id,
    tactic_id: tacticId,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: "Created as Addressed with accompanying tactic.",
  });
  await db()
    .update(t.gaps)
    .set({
      status: "validated_addressed",
      computed_status: "validated_addressed",
      human_validated: true,
      lock: makeLock(args.actor_name, args.actor_function, args.note),
    })
    .where(eq(t.gaps.id, id));
  return id;
}

/**
 * Breakout groups are a workshop-day organizational overlay, not a locked
 * evidence object — no version history, just a plain audit line.
 */
export async function createBreakoutGroup(args: {
  name: string;
  note?: string;
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<string> {
  const name = args.name.trim();
  if (!name) throw new Error("A breakout group needs a name.");
  const state = await loadState();
  const id = nextId(
    "BRK",
    state.breakout_groups.map((g) => g.id),
  );
  await db().insert(t.breakoutGroups).values({
    id,
    name,
    note: args.note?.trim() || null,
    created_at: now(),
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  await appendAudit(args.actor_name, args.actor_function, "breakout_group", id, "create", name);
  return id;
}

export async function deleteBreakoutGroup(args: {
  group_id: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const group = state.breakout_groups.find((g) => g.id === args.group_id);
  if (!group) throw new Error("Breakout group not found");
  await db().delete(t.breakoutGroupGaps).where(eq(t.breakoutGroupGaps.group_id, args.group_id));
  await db().delete(t.breakoutGroups).where(eq(t.breakoutGroups.id, args.group_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "breakout_group",
    args.group_id,
    "delete",
    group.name,
  );
}

export async function assignGapToBreakoutGroup(args: {
  group_id: string;
  gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const group = state.breakout_groups.find((g) => g.id === args.group_id);
  if (!group) throw new Error("Breakout group not found");
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  const existing = state.breakout_group_gaps.find(
    (row) => row.group_id === args.group_id && row.gap_id === args.gap_id,
  );
  if (existing) return;
  await db().insert(t.breakoutGroupGaps).values({ group_id: args.group_id, gap_id: args.gap_id });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "breakout_group",
    args.group_id,
    "assign_gap",
    `${gap.name} → ${group.name}`,
  );
}

export async function unassignGapFromBreakoutGroup(args: {
  group_id: string;
  gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  await db()
    .delete(t.breakoutGroupGaps)
    .where(
      and(eq(t.breakoutGroupGaps.group_id, args.group_id), eq(t.breakoutGroupGaps.gap_id, args.gap_id)),
    );
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "breakout_group",
    args.group_id,
    "unassign_gap",
    args.gap_id,
  );
}
