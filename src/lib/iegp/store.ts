import { and, eq } from "drizzle-orm";
import { db, ensureSchema, wipeIegp } from "./db";
import * as t from "./schema";
import { buildBlankWorkspace } from "./blank";
import { buildSeed } from "./seed";
import type { IegpState, Lock } from "./types";
import type { ActorFunction, EvidenceDomain } from "./enums";
import { EVIDENCE_DOMAINS } from "./enums";
import {
  draftResidualStatement,
  emptyDimensions,
  extractCandidateGaps,
  extractCandidateNeeds,
  extractCandidateTactics,
  gapEligibleForMapping,
  gapNameFromStatement,
  residualRequired,
  splitSourceIntoBlocks,
  similarRecord,
  suggestGapStatus,
  suggestMappings as rankMappingSuggestions,
  tacticEligibleForMapping,
  unlocked,
} from "./engine";

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
    residuals,
    priorities,
    roadmap,
    audit,
    gold_needs,
    gold_coverages,
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
    d.select().from(t.residuals),
    d.select().from(t.priorities),
    d.select().from(t.roadmap),
    d.select().from(t.audit),
    d.select().from(t.goldNeeds),
    d.select().from(t.goldCoverages),
  ]);
  const asset = assetRows[0]!;
  return {
    asset: {
      ...asset,
      wizard_complete: Boolean(asset.wizard_complete),
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
    })),
    mapping_suggestions: mapping_suggestions.map((m) => ({
      gap_id: m.gap_id,
      tactic_id: m.tactic_id,
      status: m.status as IegpState["mapping_suggestions"][0]["status"],
      lock: asLock(m.lock),
    })),
    residuals: residuals.map((r) => ({
      ...r,
      domain: r.domain as IegpState["residuals"][0]["domain"],
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
        return { ...rest, lock: status_lock };
      }),
    );
  }
  if (state.need_gap_links.length) await d.insert(t.needGapLinks).values(state.need_gap_links);
  if (state.tactics.length) await d.insert(t.tactics).values(state.tactics);
  if (state.coverages.length) await d.insert(t.coverages).values(state.coverages);
  if (state.mapping_suggestions.length) {
    await d.insert(t.mappingSuggestions).values(state.mapping_suggestions);
  }
  if (state.residuals.length) await d.insert(t.residuals).values(state.residuals);
  if (state.priorities.length) await d.insert(t.priorities).values(state.priorities);
  if (state.roadmap.length) await d.insert(t.roadmap).values(state.roadmap);
  if (state.audit.length) await d.insert(t.audit).values(state.audit);
  if (state.gold_needs.length) await d.insert(t.goldNeeds).values(state.gold_needs);
  if (state.gold_coverages.length) await d.insert(t.goldCoverages).values(state.gold_coverages);
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

export async function appendAudit(
  actor_name: string,
  actor_function: ActorFunction,
  entity_type: string,
  entity_id: string,
  action: string,
  detail: string,
) {
  await db().insert(t.audit).values({
    id: `AUD-${Date.now()}`,
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
  if (args.status === "validated_addressed") {
    const cov = state.coverages.filter((c) => c.gap_id === args.gap_id);
    const suggested = suggestGapStatus(cov);
    if (suggested !== "validated_addressed" && !args.note) {
      throw new Error(
        "Cannot lock Addressed unless coverage is Full, or provide a note explaining the override. Engine never auto-closes gaps.",
      );
    }
  }
  const lk = makeLock(args.actor_name, args.actor_function, args.note);
  await db()
    .update(t.gaps)
    .set({
      status: args.status,
      exclusion_reason: args.exclusion_reason ?? null,
      exclusion_note: args.exclusion_note ?? null,
      lock: lk,
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
  if (residualRequired(args.status)) {
    await ensureResidualDraft(args.gap_id);
  }
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
    .set({ dimensions, stale: false })
    .where(eq(t.coverages.id, args.coverage_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    args.coverage_id,
    "lock_dimension",
    `${args.dimension}=${args.value}`,
  );
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
    })
    .where(eq(t.coverages.id, args.coverage_id));
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    args.coverage_id,
    "lock_overall",
    args.overall,
  );
  await ensureResidualDraft(row.gap_id);
}

async function ensureResidualDraft(gap_id: string) {
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === gap_id);
  if (!gap) return;
  if (gap.status === "validated_addressed" || gap.status === "excluded") return;
  const coverages = state.coverages.filter((c) => c.gap_id === gap_id);
  const draft = draftResidualStatement({ gap, coverages });
  const existing = state.residuals.find((r) => r.gap_id === gap_id);
  if (existing) {
    if (existing.lock.locked) return;
    await db()
      .update(t.residuals)
      .set({
        statement: draft.statement,
        draft_rationale: draft.rationale,
        domain: draft.domain,
      })
      .where(eq(t.residuals.id, existing.id));
    return;
  }
  await db().insert(t.residuals).values({
    id: nextId("RES", state.residuals.map((r) => r.id)),
    gap_id,
    statement: draft.statement,
    domain: draft.domain,
    draft_rationale: draft.rationale,
    lock: unlocked(),
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
  const state = await loadState();
  const id = nextId("TAC", state.tactics.map((x) => x.id));
  await db().insert(t.tactics).values({
    id,
    name: args.name,
    type: args.type,
    description: args.description || args.name,
    evidence_question: args.evidence_question,
    population: args.population || "To be specified",
    intervention: args.intervention || "Velmara",
    comparator: args.comparator || "To be specified",
    outcomes: args.outcomes || "To be specified",
    geography: args.geography || state.asset.geography,
    data_source: "To be designed",
    study_design: "To be designed",
    lifecycle_stage: "proposed",
    status: "proposed",
    review_status: "accepted",
    start_date: null,
    evidence_available: null,
    owner: args.owner || args.actor_name,
    function: args.function || "evidence_lead",
    budget: null,
    intended_use: args.residual_ids.join(", "),
    lock: unlocked(),
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "tactic",
    id,
    "create_proposed",
    args.name,
  );
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
    stale: true,
  });
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "coverage",
    coverageId,
    "assign_tactic",
    `${args.tactic_id} → ${args.gap_id}`,
  );
  await ensureResidualDraft(args.gap_id);
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

export async function createGap(args: {
  name?: string;
  statement: string;
  domain?: EvidenceDomain;
  actor_name: string;
  actor_function: ActorFunction;
  note?: string;
}) {
  const statement = args.statement.trim();
  if (!statement) throw new Error("Statement is required.");
  const domain = args.domain && EVIDENCE_DOMAINS.includes(args.domain) ? args.domain : "unmet_need";
  const state = await loadState();
  const obj = state.objectives[0];
  if (!obj) throw new Error("No strategic objective to attach this gap to.");
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
  });
  await appendAudit(args.actor_name, args.actor_function, "gap", id, "create", name);
  await ensureResidualDraft(id);
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
  const residual = state.residuals.find((r) => r.gap_id === args.gap_id);
  if (!residual || !residual.lock.locked) {
    await ensureResidualDraft(args.gap_id);
  }
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
      await db()
        .update(t.coverages)
        .set({ stale: true })
        .where(eq(t.coverages.id, c.id));
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
    `${prev} → ${args.status} (stale coverage queued)`,
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
  const gapIds = [...state.gaps.map((g) => g.id)];
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
    });
  }

  for (const [index, gapRow] of gapPool.entries()) {
    const existing = state.gaps.find(
      (g) =>
        g.status !== "excluded" &&
        (similarRecord(g.statement, gapRow.statement) || similarRecord(g.name, gapRow.name)),
    );
    const linkedNeedId = createdNeedIds[Math.min(index, createdNeedIds.length - 1)];
    if (existing) {
      continue;
    }
    const gapId = nextId("GAP", gapIds);
    gapIds.push(gapId);
    createdGapIds.push(gapId);
    await db().insert(t.gaps).values({
      id: gapId,
      name: gapRow.name,
      statement: gapRow.statement,
      domain: gapRow.domain,
      objective_id: obj.id,
      status: "candidate",
      exclusion_reason: null,
      exclusion_note: null,
      lock: unlocked(),
    });
    if (linkedNeedId) {
      await db()
        .insert(t.needGapLinks)
        .values({ need_id: linkedNeedId, gap_id: gapId, role: "primary" })
        .onConflictDoNothing();
    }
    await ensureResidualDraft(gapId);
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
      status: "proposed",
      review_status: "candidate",
      start_date: null,
      evidence_available: null,
      owner: args.actor_name,
      function: args.actor_function,
      budget: null,
      intended_use: `Extracted from ${sourceId}`,
      lock: unlocked(),
    });
  }

  for (const c of state.coverages) {
    await db().update(t.coverages).set({ stale: true }).where(eq(t.coverages.id, c.id));
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "source",
    sourceId,
    "ingest",
    `Ingested ${args.title}; ${createdNeedIds.length} candidate need(s), ${createdGapIds.length} candidate gap(s), ${tacticCount} extracted tactic(s); residual drafts created; coverage marked stale.`,
  );
  return sourceId;
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
