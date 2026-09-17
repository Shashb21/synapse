import { eq } from "drizzle-orm";
import { db, ensureSchema, wipeIegp } from "./db";
import * as t from "./schema";
import { buildSeed } from "./seed";
import type { IegpState, Lock } from "./types";
import type { ActorFunction } from "./enums";
import { draftResidualStatement, residualRequired, suggestGapStatus, suggestPriority } from "./engine";
import { unlocked } from "./engine";

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
    await persistState(buildSeed());
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
    d.select().from(t.residuals),
    d.select().from(t.priorities),
    d.select().from(t.roadmap),
    d.select().from(t.audit),
    d.select().from(t.goldNeeds),
    d.select().from(t.goldCoverages),
  ]);
  const asset = assetRows[0]!;
  return {
    asset,
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
      function: x.function as ActorFunction,
      lock: asLock(x.lock),
    })),
    coverages: coverages.map((c) => ({
      ...c,
      dimensions: c.dimensions as IegpState["coverages"][0]["dimensions"],
      overall: c.overall as IegpState["coverages"][0]["overall"],
      overall_lock: asLock(c.overall_lock),
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
  if (state.residuals.length) await d.insert(t.residuals).values(state.residuals);
  if (state.priorities.length) await d.insert(t.priorities).values(state.priorities);
  if (state.roadmap.length) await d.insert(t.roadmap).values(state.roadmap);
  if (state.audit.length) await d.insert(t.audit).values(state.audit);
  if (state.gold_needs.length) await d.insert(t.goldNeeds).values(state.gold_needs);
  if (state.gold_coverages.length) await d.insert(t.goldCoverages).values(state.gold_coverages);
}

export async function resetSeed() {
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
  if (!residual.lock.locked) {
    throw new Error("Lock the residual statement before priority.");
  }
  const gap = state.gaps.find((g) => g.id === residual.gap_id)!;
  const objective = state.objectives.find((o) => o.id === gap.objective_id)!;
  const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
  const suggested = suggestPriority({
    residual,
    objective,
    coverages,
    stakeholder: state.needs.find((n) =>
      state.need_gap_links.some(
        (l) => l.gap_id === gap.id && l.need_id === n.id && l.role === "primary",
      ),
    )?.stakeholder,
  });
  const existing = state.priorities.find((p) => p.residual_id === args.residual_id);
  const row = {
    residual_id: args.residual_id,
    suggested_score: suggested.score,
    suggested_band: suggested.band,
    band: args.band,
    override_reason:
      args.band !== suggested.band ? args.override_reason ?? "Human override" : args.override_reason ?? null,
    reasons: suggested.reasons,
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
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const id = nextId("TAC", state.tactics.map((x) => x.id));
  await db().insert(t.tactics).values({
    id,
    name: args.name,
    type: args.type,
    description: args.description,
    evidence_question: args.evidence_question,
    population: args.population,
    intervention: args.intervention,
    comparator: args.comparator,
    outcomes: args.outcomes,
    geography: args.geography,
    data_source: "To be designed",
    study_design: "To be designed",
    lifecycle_stage: "proposed",
    status: "proposed",
    start_date: null,
    evidence_available: null,
    owner: args.owner,
    function: args.function,
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
  return id;
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
  actor_name: string;
  actor_function: ActorFunction;
}) {
  const state = await loadState();
  const sourceId = nextId("SRC", state.sources.map((s) => s.id));
  const ingested_at = now();
  await db().insert(t.sources).values({
    id: sourceId,
    filename: args.title.replaceAll(" ", "_") + ".txt",
    title: args.title,
    source_type: args.source_type,
    stakeholder_function: args.stakeholder_function,
    ingested_at,
    full_text: args.text,
  });
  const sentences = args.text.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 20);
  const blockId = `${sourceId}-B01`;
  await db().insert(t.sourceBlocks).values({
    id: blockId,
    source_id: sourceId,
    heading: args.title,
    text: args.text,
    location: "Uploaded note",
  });
  const { extractCandidateNeeds } = await import("./engine");
  const extracted = extractCandidateNeeds([
    { id: blockId, source_id: sourceId, text: args.text, heading: args.title },
  ]);
  const obj = state.objectives[0]!;
  let i = 0;
  for (const row of extracted.length ? extracted : sentences.slice(0, 3).map((s, idx) => ({
    id: `tmp-${idx}`,
    statement: s,
    source_id: sourceId,
    source_quote: s,
  }))) {
    i += 1;
    const id = nextId("NEED", [...state.needs.map((n) => n.id), `NEED-${100 + i}`]);
    await db().insert(t.needs).values({
      id,
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
  const relatedGaps = state.gaps.map((g) => g.id);
  for (const c of state.coverages.filter((c) => relatedGaps.includes(c.gap_id))) {
    await db().update(t.coverages).set({ stale: true }).where(eq(t.coverages.id, c.id));
  }
  await appendAudit(
    args.actor_name,
    args.actor_function,
    "source",
    sourceId,
    "ingest",
    `Ingested ${args.title}; candidate needs queued; coverage marked stale for re-lock.`,
  );
  return sourceId;
}
