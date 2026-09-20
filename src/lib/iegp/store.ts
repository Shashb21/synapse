import { and, eq } from "drizzle-orm";
import { db, ensureSchema, wipeIegp } from "./db";
import * as t from "./schema";
import { buildBlankWorkspace } from "./blank";
import { buildSeed } from "./seed";
import type { IegpState, Lock, GapStatusOverride } from "./types";
import type { ExtractGap, ExtractNeed } from "./extract/contracts";
import { coerceEvidenceDomain } from "./extract/contracts";
import type {
  ActorFunction,
  CatchUpReason,
  CatchUpTacticStatus,
  EvidenceDomain,
  MappedGapStatus,
} from "./enums";
import {
  CATCH_UP_REASON_LABELS,
  CATCH_UP_REASONS,
  CATCH_UP_TACTIC_STATUSES,
  EVIDENCE_DOMAINS,
  TACTIC_TYPES,
} from "./enums";
import {
  computeGapStatus,
  displayedGapStatus,
  draftResidualGapSuggestion,
  emptyDimensions,
  extractCandidateGaps,
  extractCandidateNeeds,
  extractCandidateTactics,
  gapEligibleForMapping,
  gapNameFromStatement,
  gapsReadyForPrioritize,
  isLiveGap,
  requireOverrideReason,
  residualGapEligible,
  splitSourceIntoBlocks,
  similarRecord,
  suggestMappings as rankMappingSuggestions,
  suggestResidualGaps as rankResidualGapSuggestions,
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
  ]);
  const asset = assetRows[0]!;
  return {
    asset: {
      ...asset,
      wizard_complete: Boolean(asset.wizard_complete),
      tactics_unlocked: Boolean(asset.tactics_unlocked),
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
      metadata: (n.metadata as Record<string, unknown> | null) ?? {},
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
      metadata: (g.metadata as Record<string, unknown> | null) ?? {},
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
        return { ...rest, lock: status_lock, metadata: n.metadata ?? {} };
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
          metadata: g.metadata ?? {},
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

async function notifyGapExtractFeedback(args: {
  gap_id: string;
  kind: "wording" | "not_a_gap" | "is_a_gap" | "missed";
  before: { name?: string; statement?: string; domain?: string };
  after: { name?: string; statement?: string; domain?: string };
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  try {
    const state = await loadState();
    const need = state.need_gap_links
      .filter((l) => l.gap_id === args.gap_id)
      .map((l) => state.needs.find((n) => n.id === l.need_id))
      .find(Boolean);
    const { recordHumanGapFeedback } = await import("./extract/feedback");
    await recordHumanGapFeedback({
      ...args,
      source_key: need?.source_id,
      source_quote: need?.source_quote,
    });
  } catch {
    // Human locks must not fail because the extractor is unconfigured.
  }
}

function nextId(prefix: string, existing: string[]) {
  const nums = existing
    .map((id) => Number(id.split("-").pop()?.replace(/\D/g, "") || 0))
    .filter((n) => Number.isFinite(n));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

const PLAN_ENTRY_SOURCE_ID = "SRC-PLAN-ENTRY";

function findMatchingLiveGap(
  state: IegpState,
  text: string,
): IegpState["gaps"][0] | undefined {
  const hay = text.trim();
  if (!hay) return undefined;
  return state.gaps.find(
    (g) =>
      isLiveGap(g) &&
      (similarRecord(g.statement, hay) || similarRecord(g.name, hay)),
  );
}

function gapHasNeedFromSource(state: IegpState, gapId: string, sourceId: string): boolean {
  const needIds = new Set(
    state.need_gap_links.filter((l) => l.gap_id === gapId).map((l) => l.need_id),
  );
  return state.needs.some((n) => needIds.has(n.id) && n.source_id === sourceId);
}

function primaryRoleForGap(state: IegpState, gapId: string): "primary" | "supporting" {
  return state.need_gap_links.some((l) => l.gap_id === gapId && l.role === "primary")
    ? "supporting"
    : "primary";
}

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
  metadata?: Record<string, unknown>;
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
    metadata: args.metadata ?? {},
  });
  return gapId;
}

async function attachExistingSimilarNeed(gapId: string): Promise<boolean> {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === gapId);
  if (!gap) return false;
  const linkedNeedIds = new Set(
    state.need_gap_links.filter((l) => l.gap_id === gapId).map((l) => l.need_id),
  );
  const similarNeed = state.needs.find(
    (n) =>
      !linkedNeedIds.has(n.id) &&
      (similarRecord(n.statement, gap.statement, 0.62) || similarRecord(n.statement, gap.name, 0.62)),
  );
  if (!similarNeed) return false;
  await linkNeedOntoGap(similarNeed.id, gapId, primaryRoleForGap(state, gapId));
  return true;
}

async function insertNeedForGap(args: {
  gapId: string;
  sourceId: string;
  statement: string;
  sourceQuote: string;
  role: "primary" | "supporting";
  actor_function: ActorFunction;
  domain?: EvidenceDomain;
  pico?: {
    population?: string;
    intervention?: string;
    comparator?: string;
    outcome?: string;
    geography?: string;
    timing?: string;
    decision_supported?: string;
  };
  metadata?: Record<string, unknown>;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gapId);
  const obj = state.objectives[0];
  if (!obj) throw new Error("No strategic objective to attach this need to.");
  const statement = args.statement.trim();
  if (!statement) return;
  const needId = nextId(
    "NEED",
    state.needs.map((n) => n.id),
  );
  await db().insert(t.needs).values({
    id: needId,
    statement,
    domain: args.domain ?? gap?.domain ?? "unmet_need",
    stakeholder: args.actor_function,
    objective_id: obj.id,
    decision_supported: args.pico?.decision_supported ?? obj.key_decision,
    geography: args.pico?.geography ?? state.asset.geography,
    population: args.pico?.population ?? "To be specified",
    intervention: args.pico?.intervention ?? "Velmara",
    comparator: args.pico?.comparator ?? "To be specified",
    outcome: args.pico?.outcome ?? "To be specified",
    timing: args.pico?.timing ?? "To be specified",
    source_id: args.sourceId,
    source_quote: args.sourceQuote.trim().slice(0, 500) || statement.slice(0, 500),
    confidence: 0.5,
    status: "candidate",
    lock: unlocked(),
    metadata: args.metadata ?? {},
  });
  await db()
    .insert(t.needGapLinks)
    .values({ need_id: needId, gap_id: args.gapId, role: args.role })
    .onConflictDoNothing();
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
  if (await attachExistingSimilarNeed(gapId)) return;
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
}

function childParents(state: IegpState): Set<string> {
  return new Set(
    state.gaps.map((g) => g.parent_gap_id).filter((id): id is string => Boolean(id)),
  );
}

async function applyMappedStatusSideEffects(args: {
  gap_id: string;
  status: MappedGapStatus;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  if (args.status === "validated_partial") {
    const after = await loadState();
    const g = after.gaps.find((row) => row.id === args.gap_id);
    if (g) {
      const hasChild = after.gaps.some((row) => row.parent_gap_id === g.id);
      const existing = after.residual_gap_suggestions.find((row) => row.parent_gap_id === g.id);
      if (!hasChild && existing?.status !== "accepted" && existing?.status !== "rejected") {
        const mapped = after.coverages.filter((c) => c.gap_id === g.id);
        const draft = draftResidualGapSuggestion({ gap: g, coverages: mapped });
        await upsertResidualGapSuggestion({
          parent_gap_id: g.id,
          statement: existing?.status === "candidate" ? existing.statement : draft.statement,
          reasons: draft.reasons,
          status: "candidate",
          actor_name: args.actor_name,
          actor_function: args.actor_function,
          note: "Partially Addressed. Residual leftover drafted for split.",
        });
      }
    }
    await persistEligibleResidualDrafts();
  }
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

export async function syncComputedGapStatuses(gapId?: string) {
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
    if (gap.status !== computed || gap.computed_status !== computed) {
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
      if (gap.status !== computed) {
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
  const mapped =
    args.status === "validated_open" ||
    args.status === "validated_addressed";
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
  if (args.status === "excluded") {
    await notifyGapExtractFeedback({
      gap_id: args.gap_id,
      kind: "not_a_gap",
      before: { name: gap.name, statement: gap.statement, domain: gap.domain },
      after: { name: gap.name, statement: gap.statement, domain: gap.domain },
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: args.exclusion_note || args.note,
    });
  }
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
  const state = await loadState();
  const row = state.coverages.find((c) => c.id === args.coverage_id);
  if (!row) throw new Error("Coverage not found");
  const dimensions = {
    ...row.dimensions,
    [args.dimension]: {
      value: args.value,
      rationale: args.rationale,
      lock: makeLock(args.actor_name, args.actor_function, args.rationale),
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
    `${args.dimension}=${args.value}`,
  );
  await syncComputedGapStatuses(row.gap_id);
}

export async function lockCoverageOverall(args: {
  coverage_id: string;
  overall: IegpState["coverages"][0]["overall"];
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const row = state.coverages.find((c) => c.id === args.coverage_id);
  if (!row) throw new Error("Coverage not found");
  await db()
    .update(t.coverages)
    .set({
      overall: args.overall,
      overall_rationale: args.rationale,
      overall_lock: makeLock(args.actor_name, args.actor_function, args.rationale),
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
    args.overall,
  );
  await enqueueResidualGapSuggestion({
    gap_id: row.gap_id,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  await persistEligibleResidualDrafts();
  await syncComputedGapStatuses(row.gap_id);
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



async function enqueueResidualGapSuggestion(args: {
  gap_id: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) return;
  const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
  const hasChild = state.gaps.some((g) => g.parent_gap_id === gap.id);
  const existing = state.residual_gap_suggestions.find((row) => row.parent_gap_id === gap.id);
  if (existing?.status === "accepted" || existing?.status === "rejected") return;
  if (
    !residualGapEligible({
      gap,
      coverages,
      hasChild,
      suppressed: Boolean(existing && existing.status !== "candidate"),
    })
  ) {
    return;
  }
  const draft = draftResidualGapSuggestion({ gap, coverages });
  await upsertResidualGapSuggestion({
    parent_gap_id: gap.id,
    statement: existing?.status === "candidate" ? existing.statement : draft.statement,
    reasons: draft.reasons,
    status: "candidate",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: "Pressure-test leftover suggested as a new gap.",
  });
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
    population: args.population || "To be specified",
    intervention: args.intervention || "Velmara",
    comparator: args.comparator || "To be specified",
    outcomes: args.outcomes || "To be specified",
    geography: args.geography || state.asset.geography,
    data_source: args.data_source || "To be designed",
    study_design: "To be designed",
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
  geography: string;
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
    data_source: reasonLabel || "Recorded while reviewing gaps",
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

export async function assignTacticToGap(args: {
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
  if (tactic.review_status !== "accepted") {
    throw new Error("Only accepted tactics can be assigned to a gap.");
  }
  const existing = state.coverages.find(
    (c) => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id,
  );
  if (existing) {
    throw new Error("That tactic is already assigned to this gap.");
  }
  const coverageId = nextId("COV", state.coverages.map((c) => c.id));
  await db().insert(t.coverages).values({
    id: coverageId,
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    dimensions: emptyDimensions(),
    overall: "limited",
    overall_rationale:
      args.note ||
      "Assigned from the plan. Coverage dimensions are unlocked until a human assesses them.",
    overall_lock: unlocked(),
    stale: false,
    needs_review: false,
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    coverageId,
    "assign_tactic",
    `${args.tactic_id} → ${args.gap_id}`,
  );
  await syncComputedGapStatuses(args.gap_id);
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

export async function suggestMappings() {
  return rankMappingSuggestions(await loadState());
}

export async function acceptMapping(args: {
  gap_id: string;
  tactic_id: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
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
  await upsertMappingSuggestion({
    ...args,
    status: "accepted",
    note: args.note || "Accepted mapping suggestion.",
  });
  await assignTacticToGap({
    ...args,
    note: args.note || "Accepted mapping suggestion.",
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "mapping",
    `${args.gap_id}::${args.tactic_id}`,
    "accept_mapping",
    `${args.tactic_id} → ${args.gap_id}`,
  );
}

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
    throw new Error("That tactic already covers this gap. Reject does not remove an assignment.");
  }
  await upsertMappingSuggestion({
    ...args,
    status: "rejected",
    note: args.note || "Rejected mapping suggestion.",
  });
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
    draft_rationale: args.rationale || existing?.draft_rationale || "Pressure-test leftover.",
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

async function persistEligibleResidualDrafts() {
  const state = await loadState();
  for (const draft of rankResidualGapSuggestions(state)) {
    await consumeResidualRecord({
      gap_id: draft.parent_gap_id,
      statement: draft.statement,
      domain: draft.domain,
      rationale: draft.reasons.join(" "),
      review_status: "candidate",
      created_gap_id: null,
      actor_name: "Engine",
      actor_function: "evidence_lead",
      note: "Pressure-test draft. Human must accept, reject, or modify in Review.",
    });
  }
}

export async function suggestResidualGaps() {
  return rankResidualGapSuggestions(await loadState());
}

function liveResidualDraft(state: IegpState, parent_gap_id: string) {
  return rankResidualGapSuggestions(state).find((row) => row.parent_gap_id === parent_gap_id);
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
  const draft = liveResidualDraft(state, args.parent_gap_id);
  const saved = state.residual_gap_suggestions.find(
    (row) => row.parent_gap_id === args.parent_gap_id && row.status === "candidate",
  );
  if (!draft && !saved && !args.statement?.trim()) {
    throw new Error("No leftover residual to accept.");
  }
  const statement = (args.statement || saved?.statement || draft?.statement || "").trim();
  if (!statement) throw new Error("Statement is required.");
  const childId = await createGap({
    statement,
    domain: draft?.domain ?? parent.domain,
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
    reasons: draft?.reasons ?? saved?.reasons ?? ["Human accepted residual as a new gap."],
    status: "accepted",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Accepted leftover as a new gap.",
  });
  await consumeResidualRecord({
    gap_id: args.parent_gap_id,
    statement,
    domain: draft?.domain ?? parent.domain,
    rationale: (draft?.reasons ?? []).join(" "),
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
  return childId;
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
  const draft = liveResidualDraft(state, args.parent_gap_id);
  await upsertResidualGapSuggestion({
    parent_gap_id: args.parent_gap_id,
    statement,
    reasons: draft?.reasons ?? ["Human modified the leftover statement."],
    status: "candidate",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Modified residual statement.",
  });
  await consumeResidualRecord({
    gap_id: args.parent_gap_id,
    statement,
    domain: draft?.domain ?? parent.domain,
    rationale: (draft?.reasons ?? ["Human modified the leftover statement."]).join(" "),
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
  const draft = liveResidualDraft(state, args.parent_gap_id);
  await upsertResidualGapSuggestion({
    parent_gap_id: args.parent_gap_id,
    statement: draft?.statement ?? parent.statement,
    reasons: draft?.reasons ?? ["Human rejected this leftover."],
    status: "rejected",
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note || "Rejected leftover-as-new-gap suggestion.",
  });
  await consumeResidualRecord({
    gap_id: args.parent_gap_id,
    statement: draft?.statement ?? parent.statement,
    domain: draft?.domain ?? parent.domain,
    rationale: (draft?.reasons ?? ["Human rejected this leftover."]).join(" "),
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
}

export async function createGap(args: {
  name?: string;
  statement: string;
  domain?: EvidenceDomain;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
  parent_gap_id?: string | null;
}) {
  const statement = args.statement.trim();
  if (!statement) throw new Error("Statement is required.");
  const domain = args.domain && EVIDENCE_DOMAINS.includes(args.domain) ? args.domain : "unmet_need";
  const state = await loadState();
  const obj = state.objectives[0];
  if (!obj) throw new Error("No strategic objective to attach this gap to.");
  if (args.parent_gap_id) {
    const parent = state.gaps.find((g) => g.id === args.parent_gap_id);
    if (!parent) throw new Error("Parent gap not found");
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
    metadata: {},
  });
  await appendAudit(args.actor_name, args.actor_function, "gap", id, "create", name);
  await syncComputedGapStatuses(id);
  if (args.parent_gap_id) await syncComputedGapStatuses(args.parent_gap_id);
  await ensureGapHasConstituentNeed(id);
  if (!args.parent_gap_id) {
    await notifyGapExtractFeedback({
      gap_id: id,
      kind: "missed",
      before: {},
      after: { name, statement, domain },
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: args.note,
    });
  }
  return id;
}

export async function modifyGap(args: {
  gap_id: string;
  name: string;
  statement: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  await db()
    .update(t.gaps)
    .set({ name: args.name, statement: args.statement })
    .where(eq(t.gaps.id, args.gap_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "gap",
    args.gap_id,
    "modify",
    args.note || `${gap.name} → ${args.name}`,
  );
  await notifyGapExtractFeedback({
    gap_id: args.gap_id,
    kind: "wording",
    before: { name: gap.name, statement: gap.statement, domain: gap.domain },
    after: { name: args.name, statement: args.statement, domain: gap.domain },
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note,
  });
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
    const related = state.coverages.filter((c) => c.tactic_id === args.tactic_id);
    for (const c of related) {
      const residuals = state.residuals.filter((r) => r.gap_id === c.gap_id);
      for (const r of residuals) {
        await db()
          .update(t.residuals)
          .set({ lock: unlocked() })
          .where(eq(t.residuals.id, r.id));
      }
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
  if (prev !== args.status) {
    const related = state.coverages.filter((c) => c.tactic_id === args.tactic_id);
    for (const c of related) {
      await syncComputedGapStatuses(c.gap_id);
    }
  }
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

export async function ingestNeedFromText(args: {
  title: string;
  source_type: IegpState["sources"][0]["source_type"];
  stakeholder_function: ActorFunction;
  text: string;
  filename?: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const sourceId = nextId("SRC", state.sources.map((s) => s.id));
  const ingested_at = now();
  await db().insert(t.sources).values({
    id: sourceId,
    filename: args.filename ?? args.title.replaceAll(" ", "_") + ".txt",
    title: args.title,
    source_type: args.source_type,
    stakeholder_function: args.stakeholder_function,
    ingested_at,
    full_text: args.text,
  });
  const sections = splitSourceIntoBlocks(args.text, args.title);
  const blocks = sections.map((section, i) => ({
    id: `${sourceId}-B${String(i + 1).padStart(2, "0")}`,
    source_id: sourceId,
    heading: section.heading,
    text: section.text,
    location: section.heading === "Note" ? "Uploaded note" : section.heading,
  }));
  if (blocks.length) await db().insert(t.sourceBlocks).values(blocks);
  const extractedNeeds = extractCandidateNeeds(blocks);
  const extractedGaps = extractCandidateGaps(blocks);
  const extractedTactics = extractCandidateTactics(blocks);
  const fallbackSentences = args.text
    .split(/(?<=[.?!])\s+/)
    .filter((s) => s.trim().length > 20)
    .slice(0, 3)
    .map((s, idx) => ({
      id: `tmp-${idx}`,
      statement: s,
      source_id: sourceId,
      source_quote: s,
    }));
  const needRows = extractedNeeds.length ? extractedNeeds : fallbackSentences;
  const obj = state.objectives[0]!;
  const needIds = [...state.needs.map((n) => n.id)];
  const tacticIds = [...state.tactics.map((x) => x.id)];
  const createdGapIds: string[] = [];
  const createdNeedIds: string[] = [];

  const gapPool = extractedGaps.length
    ? extractedGaps
    : needRows.map((row) => ({
        id: row.id,
        name: gapNameFromStatement(row.statement),
        statement: row.statement,
        domain: "unmet_need" as const,
        source_id: sourceId,
        source_quote: row.source_quote,
      }));

  for (const row of needRows) {
    const needId = nextId("NEED", needIds);
    needIds.push(needId);
    createdNeedIds.push(needId);
    await db().insert(t.needs).values({
      id: needId,
      statement: row.statement,
      domain: "unmet_need",
      stakeholder: args.stakeholder_function,
      objective_id: obj.id,
      decision_supported: obj.key_decision,
      geography: state.asset.geography,
      population: "To be specified",
      intervention: "Velmara",
      comparator: "To be specified",
      outcome: "To be specified",
      timing: "To be specified",
      source_id: sourceId,
      source_quote: row.source_quote,
      confidence: 0.5,
      status: "candidate",
      lock: unlocked(),
      metadata: {},
    });
  }

  const attachSourceNeedToGap = async (gapId: string, preferredStatement: string, quote: string) => {
    const live = await loadState();
    if (gapHasNeedFromSource(live, gapId, sourceId)) return;
    const fromThisSource = live.needs.find(
      (n) =>
        n.source_id === sourceId &&
        (similarRecord(n.statement, preferredStatement) || similarRecord(n.statement, quote)),
    );
    const role = primaryRoleForGap(live, gapId);
    if (fromThisSource) {
      await linkNeedOntoGap(fromThisSource.id, gapId, role);
      return;
    }
    await insertNeedForGap({
      gapId,
      sourceId,
      statement: preferredStatement,
      sourceQuote: quote,
      role,
      actor_function: args.stakeholder_function,
    });
  };

  for (const gapRow of gapPool) {
    const live = await loadState();
    const existing =
      findMatchingLiveGap(live, gapRow.statement) ?? findMatchingLiveGap(live, gapRow.name);
    if (existing) {
      await attachSourceNeedToGap(existing.id, gapRow.statement, gapRow.source_quote);
      continue;
    }
    const gapId = await insertLiveOpenGap({
      name: gapRow.name,
      statement: gapRow.statement,
      domain: gapRow.domain,
      objectiveId: obj.id,
    });
    createdGapIds.push(gapId);
    await attachSourceNeedToGap(gapId, gapRow.statement, gapRow.source_quote);
  }

  for (const needId of createdNeedIds) {
    const live = await loadState();
    const need = live.needs.find((n) => n.id === needId);
    if (!need) continue;
    if (live.need_gap_links.some((l) => l.need_id === needId)) continue;
    const match = findMatchingLiveGap(live, need.statement);
    if (match) {
      await linkNeedOntoGap(needId, match.id, primaryRoleForGap(live, match.id));
      continue;
    }
    const gapId = await insertLiveOpenGap({
      name: gapNameFromStatement(need.statement),
      statement: need.statement,
      domain: "unmet_need",
      objectiveId: obj.id,
    });
    createdGapIds.push(gapId);
    await linkNeedOntoGap(needId, gapId, "primary");
  }

  let tacticCount = 0;
  for (const tac of extractedTactics) {
    const dup = state.tactics.find(
      (existing) =>
        similarRecord(existing.name, tac.name) ||
        similarRecord(existing.evidence_question, tac.evidence_question, 0.45),
    );
    if (dup) continue;
    const tacticId = nextId("TAC", tacticIds);
    tacticIds.push(tacticId);
    tacticCount += 1;
    await db().insert(t.tactics).values({
      id: tacticId,
      name: tac.name,
      type: tac.type,
      description: `Extracted from ${args.title}. Human must assign this tactic to a prioritized gap. Not ideation — inventory from the source.`,
      evidence_question: tac.evidence_question,
      population: "To be specified",
      intervention: "Velmara",
      comparator: "To be specified",
      outcomes: "To be specified",
      geography: state.asset.geography,
      data_source: args.title,
      study_design: "Extracted — not yet designed",
      lifecycle_stage: "extracted",
      status: tac.status ?? "proposed",
      review_status: "accepted",
      start_date: null,
      evidence_available: null,
      owner: args.actor_name,
      function: args.actor_function,
      budget: null,
      intended_use: `Extracted from ${sourceId}`,
      lock: unlocked(),
    });
  }

  await appendAudit(
    args.actor_name,
    args.actor_function,
    "source",
    sourceId,
    "ingest",
    `Ingested ${args.title}; ${createdNeedIds.length} need(s), ${createdGapIds.length} gap(s), ${tacticCount} tactic(s); mappings applied.`,
  );
  await autoJoinMappings(args.actor_name, args.actor_function);
  await persistEligibleResidualDrafts();
  await syncComputedGapStatuses();
  return sourceId;
}

async function autoJoinMappings(actor_name: string, actor_function: ActorFunction) {
  const suggestions = rankMappingSuggestions(await loadState());
  for (const item of suggestions) {
    const current = await loadState();
    const exists = current.coverages.some(
      (c) => c.gap_id === item.gap_id && c.tactic_id === item.tactic_id,
    );
    if (exists) continue;
    const gap = current.gaps.find((g) => g.id === item.gap_id);
    const tactic = current.tactics.find((x) => x.id === item.tactic_id);
    if (!gap || !tactic || !isLiveGap(gap)) continue;
    try {
      await assignTacticToGap({
        gap_id: item.gap_id,
        tactic_id: item.tactic_id,
        actor_name,
        actor_function,
        note: "Engine-applied mapping after ingest.",
      });
    } catch {
      // Duplicate or ineligible pair — skip.
    }
  }
}

export async function ingestDemoSource(args: {
  demo_id: string;
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const { demoSourceById } = await import("./demo-pack");
  const file = demoSourceById(args.demo_id);
  if (!file) throw new Error("Demo source file not found.");
  return ingestNeedFromText({
    title: file.title,
    source_type: file.source_type,
    stakeholder_function: file.stakeholder_function,
    text: file.text,
    filename: file.filename,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
}

export async function ingestJudgedExtraction(args: {
  title: string;
  filename?: string;
  source_type: IegpState["sources"][0]["source_type"];
  stakeholder_function: ActorFunction;
  text: string;
  blocks: { heading: string; text: string; location: string; kind?: string }[];
  gaps: ExtractGap[];
  needs: ExtractNeed[];
  actor_name: string;
  actor_function: ActorFunction;
  extract_run_id?: string;
  prompt_version?: string;
  source_key?: string;
}): Promise<{ sourceId: string; createdGapIds: string[]; mergedGapIds: string[] }> {
  const state = await loadState();
  const sourceId = nextId("SRC", state.sources.map((s) => s.id));
  const ingested_at = now();
  await db().insert(t.sources).values({
    id: sourceId,
    filename: args.filename ?? args.title.replaceAll(" ", "_") + ".txt",
    title: args.title,
    source_type: args.source_type,
    stakeholder_function: args.stakeholder_function,
    ingested_at,
    full_text: args.text,
  });
  const blocks = args.blocks.map((section, i) => ({
    id: `${sourceId}-B${String(i + 1).padStart(2, "0")}`,
    source_id: sourceId,
    heading: section.heading,
    text: section.text,
    location: section.location || section.heading,
  }));
  if (blocks.length) await db().insert(t.sourceBlocks).values(blocks);

  const obj = state.objectives[0]!;
  const createdGapIds: string[] = [];
  const mergedGapIds: string[] = [];
  const sourceKey = args.source_key || sourceId;

  const attachNeed = async (
    gapId: string,
    row: {
      statement: string;
      source_quote: string;
      pico?: ExtractGap["pico"];
      domain?: EvidenceDomain;
      extra?: Record<string, string>;
    },
  ) => {
    const live = await loadState();
    if (gapHasNeedFromSource(live, gapId, sourceId)) {
      const existingNeed = live.needs.find(
        (n) =>
          n.source_id === sourceId &&
          live.need_gap_links.some((l) => l.gap_id === gapId && l.need_id === n.id),
      );
      if (existingNeed) return;
    }
    await insertNeedForGap({
      gapId,
      sourceId,
      statement: row.statement,
      sourceQuote: row.source_quote,
      role: primaryRoleForGap(await loadState(), gapId),
      actor_function: args.stakeholder_function,
      domain: row.domain,
      pico: row.pico,
      metadata: {
        extra: row.extra ?? {},
        extract_run_id: args.extract_run_id,
      },
    });
  };

  const recordObservation = async (
    gapId: string,
    gapRow: ExtractGap,
    merged: boolean,
  ) => {
    const live = await loadState();
    const gap = live.gaps.find((g) => g.id === gapId);
    if (!gap) return;
    const prev = (gap.metadata ?? {}) as Record<string, unknown>;
    const observed = Array.isArray(prev.observed_in)
      ? [...(prev.observed_in as Record<string, string>[])]
      : [];
    observed.push({
      source_id: sourceId,
      source_title: args.title,
      source_key: sourceKey,
      quote: gapRow.source_quote,
    });
    await db()
      .update(t.gaps)
      .set({
        metadata: {
          ...prev,
          observed_in: observed,
          extract_run_id: args.extract_run_id,
          prompt_version: args.prompt_version,
          domain_label: gapRow.domain,
          domain_rationale: gapRow.domain_rationale,
          pico: gapRow.pico ?? prev.pico,
          extra: { ...(prev.extra as object | undefined), ...(gapRow.extra ?? {}) },
          merged,
        },
      })
      .where(eq(t.gaps.id, gapId));
  };

  for (const gapRow of args.gaps) {
    const domain = coerceEvidenceDomain(gapRow.domain);
    const live = await loadState();
    const existing =
      findMatchingLiveGap(live, gapRow.statement) ?? findMatchingLiveGap(live, gapRow.name);
    if (existing) {
      mergedGapIds.push(existing.id);
      const constituent =
        gapRow.needs.length > 0
          ? gapRow.needs
          : [{ statement: gapRow.statement, source_quote: gapRow.source_quote }];
      for (const need of constituent) {
        await attachNeed(existing.id, {
          statement: need.statement,
          source_quote: need.source_quote,
          pico: gapRow.pico,
          domain,
          extra: gapRow.extra,
        });
      }
      await recordObservation(existing.id, gapRow, true);
      continue;
    }
    const gapId = await insertLiveOpenGap({
      name: gapRow.name,
      statement: gapRow.statement,
      domain,
      objectiveId: obj.id,
      metadata: {
        pico: gapRow.pico ?? {},
        extra: gapRow.extra ?? {},
        domain_label: gapRow.domain,
        domain_rationale: gapRow.domain_rationale,
        extract_run_id: args.extract_run_id,
        prompt_version: args.prompt_version,
        observed_in: [
          {
            source_id: sourceId,
            source_title: args.title,
            source_key: sourceKey,
            quote: gapRow.source_quote,
          },
        ],
      },
    });
    createdGapIds.push(gapId);
    const constituent =
      gapRow.needs.length > 0
        ? gapRow.needs
        : [{ statement: gapRow.statement, source_quote: gapRow.source_quote }];
    for (const need of constituent) {
      await attachNeed(gapId, {
        statement: need.statement,
        source_quote: need.source_quote,
        pico: gapRow.pico,
        domain,
        extra: gapRow.extra,
      });
    }
  }

  for (const orphan of args.needs.filter((n) => n.is_gap === false || !n.is_gap)) {
    const live = await loadState();
    const match = findMatchingLiveGap(live, orphan.statement);
    if (!match) continue;
    if (gapHasNeedFromSource(live, match.id, sourceId)) continue;
    await attachNeed(match.id, {
      statement: orphan.statement,
      source_quote: orphan.source_quote,
    });
  }

  const extractedTactics = extractCandidateTactics(blocks);
  const tacticIds = [...state.tactics.map((x) => x.id)];
  let tacticCount = 0;
  for (const tac of extractedTactics) {
    const dup = (await loadState()).tactics.find(
      (existing) =>
        similarRecord(existing.name, tac.name) ||
        similarRecord(existing.evidence_question, tac.evidence_question, 0.45),
    );
    if (dup) continue;
    const tacticId = nextId("TAC", tacticIds);
    tacticIds.push(tacticId);
    tacticCount += 1;
    await db().insert(t.tactics).values({
      id: tacticId,
      name: tac.name,
      type: tac.type,
      description: `Extracted from ${args.title}. Human must assign this tactic to a prioritized gap. Not ideation — inventory from the source.`,
      evidence_question: tac.evidence_question,
      population: "To be specified",
      intervention: "Velmara",
      comparator: "To be specified",
      outcomes: "To be specified",
      geography: state.asset.geography,
      data_source: args.title,
      study_design: "Extracted — not yet designed",
      lifecycle_stage: "extracted",
      status: tac.status ?? "proposed",
      review_status: "accepted",
      start_date: null,
      evidence_available: null,
      owner: args.actor_name,
      function: args.actor_function,
      budget: null,
      intended_use: `Extracted from ${sourceId}`,
      lock: unlocked(),
    });
  }

  await appendAudit(
    args.actor_name,
    args.actor_function,
    "source",
    sourceId,
    "extract_ingest",
    `Agent extract ${args.title}; ${createdGapIds.length} new gap(s), ${mergedGapIds.length} joined, ${tacticCount} tactic(s).`,
  );
  await autoJoinMappings(args.actor_name, args.actor_function);
  await persistEligibleResidualDrafts();
  await syncComputedGapStatuses();
  return { sourceId, createdGapIds, mergedGapIds };
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
}

export async function modifyTactic(args: {
  tactic_id: string;
  name: string;
  evidence_question: string;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  await db()
    .update(t.tactics)
    .set({
      name: args.name,
      evidence_question: args.evidence_question,
    })
    .where(eq(t.tactics.id, args.tactic_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "tactic",
    args.tactic_id,
    "modify",
    args.note || `${tactic.name} → ${args.name}`,
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
  await notifyGapExtractFeedback({
    gap_id: args.gap_id,
    kind: "is_a_gap",
    before: { name: gap.name, statement: gap.statement, domain: gap.domain },
    after: { name: gap.name, statement: gap.statement, domain: gap.domain },
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: args.note,
  });
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
