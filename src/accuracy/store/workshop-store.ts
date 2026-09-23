import { and, desc, eq } from "drizzle-orm";
import type { Actor } from "@/accuracy/kernel/contracts";
import {
  asTacticLifecycle,
  type GapStatus,
} from "@/accuracy/modules/status-derive/engine";
import {
  assertWorkshopAction,
  coverageStatusAfterOverall,
  type WorkshopActionInput,
} from "@/accuracy/modules/workshop/actions";
import {
  assignGapToTag,
  coverageStatusFromJoins,
  emptyWorkshopPayload,
  evaluateWorkshopReadiness,
  isLiveWorkshopGap,
  normalizeTagLabel,
  type FacilitatorTagState,
  type WorkshopActionLog,
  type WorkshopGapLite,
  type WorkshopGapOverlay,
  type WorkshopInventory,
  type WorkshopReadiness,
  type WorkshopScene,
  type WorkshopSnapshotPayload,
  type WorkshopTacticLite,
  UNASSIGNED_BOARD_ID,
} from "@/accuracy/modules/workshop/readiness";
import { newId, nowIso } from "@/modules/kernel/ids";
import {
  claimMetadata,
  getClaim,
  isActiveLedgerClaim,
  listClaims,
  updateClaimMetadata,
  type AccuracyClaimRow,
} from "./claim-store";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { listCoverageJoins, upsertCoverageDecision } from "./coverage-store";

export const WORKSHOP_SNAPSHOT_DDL = `CREATE TABLE IF NOT EXISTS accuracy_workshop_snapshots (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    version integer NOT NULL,
    scene text NOT NULL,
    payload jsonb NOT NULL,
    note text,
    saved_by text NOT NULL,
    saved_function text NOT NULL,
    saved_at text NOT NULL
  )`;

export type WorkshopSnapshotRecord = {
  id: string;
  workspace_id: string;
  version: number;
  scene: WorkshopScene;
  note: string | null;
  saved_by: string;
  saved_function: string;
  saved_at: string;
  payload: WorkshopSnapshotPayload;
};

let workshopTableReady = false;

async function ensureWorkshopSchema() {
  if (!workshopTableReady) {
    await ensureAccuracySchema([WORKSHOP_SNAPSHOT_DDL]);
    workshopTableReady = true;
    return;
  }
  await ensureAccuracySchema();
}

function overrideFromMeta(meta: ReturnType<typeof claimMetadata>): GapStatus | null {
  const raw = meta.status_override;
  if (!raw || typeof raw !== "object") return null;
  const status = (raw as { status?: unknown }).status;
  if (status === "open" || status === "partial" || status === "addressed") return status;
  return null;
}

function toGapLite(
  claim: AccuracyClaimRow,
  coverage_status: WorkshopGapLite["coverage_status"],
): WorkshopGapLite {
  const meta = claimMetadata(claim);
  const priority =
    typeof meta.priority === "string"
      ? meta.priority
      : typeof meta.priority_band === "string"
        ? meta.priority_band
        : null;
  return {
    id: claim.id,
    statement: claim.statement,
    validated: claim.validated,
    status: claim.status,
    coverage_status,
    priority,
    source_badge: typeof meta.source_badge === "string" ? meta.source_badge : null,
  };
}

function toTacticLite(claim: AccuracyClaimRow): WorkshopTacticLite {
  const meta = claimMetadata(claim);
  return {
    id: claim.id,
    statement: claim.statement,
    validated: claim.validated,
    origin: typeof meta.origin === "string" ? meta.origin : null,
    tactic_status:
      asTacticLifecycle(meta.tactic_status) ?? asTacticLifecycle(claim.status) ?? null,
  };
}

export async function buildWorkshopInventory(workspace_id: string): Promise<WorkshopInventory> {
  await ensureWorkshopSchema();
  const claims = (await listClaims(workspace_id, { limit: 1000 })).filter(isActiveLedgerClaim);
  const gapRows = claims.filter((row) => row.claim_type === "gap");
  const tacticRows = claims.filter((row) => row.claim_type === "tactic");
  const joins = await listCoverageJoins(workspace_id);
  const joinLites = joins.map((join) => ({
    id: join.id,
    gap_id: join.gap_id,
    tactic_id: join.tactic_id,
    overall: join.overall,
    validated: join.validated,
    rationale: join.rationale,
  }));
  const overrides: Record<string, GapStatus | null> = {};
  for (const gap of gapRows) {
    overrides[gap.id] = overrideFromMeta(claimMetadata(gap));
  }
  const statuses = coverageStatusFromJoins({
    gap_ids: gapRows.map((gap) => gap.id),
    joins: joinLites,
    tactics: tacticRows.map((row) => {
      const meta = claimMetadata(row);
      return { id: row.id, tactic_status: String(meta.tactic_status ?? ""), status: row.status };
    }),
    overrides,
  });
  return {
    workspace_id,
    captured_at: nowIso(),
    gaps: gapRows.map((gap) => toGapLite(gap, statuses[gap.id] ?? "open")),
    tactics: tacticRows.map(toTacticLite),
    joins: joinLites,
  };
}

export async function workshopReadiness(workspace_id: string): Promise<{
  readiness: WorkshopReadiness;
  inventory: WorkshopInventory;
}> {
  const inventory = await buildWorkshopInventory(workspace_id);
  return { inventory, readiness: evaluateWorkshopReadiness({ gaps: inventory.gaps }) };
}

function toRecord(row: typeof t.accuracyWorkshopSnapshots.$inferSelect): WorkshopSnapshotRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    version: row.version,
    scene: row.scene === "prioritize" ? "prioritize" : "gaps",
    note: row.note,
    saved_by: row.saved_by,
    saved_function: row.saved_function,
    saved_at: row.saved_at,
    payload: row.payload as WorkshopSnapshotPayload,
  };
}

export async function latestWorkshopSnapshot(
  workspace_id: string,
): Promise<WorkshopSnapshotRecord | null> {
  await ensureWorkshopSchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyWorkshopSnapshots)
    .where(eq(t.accuracyWorkshopSnapshots.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyWorkshopSnapshots.version))
    .limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Always workspace-scoped — never returns another tenant's freeze. */
export async function getWorkshopSnapshot(
  workspace_id: string,
  snapshot_id: string,
): Promise<WorkshopSnapshotRecord | null> {
  await ensureWorkshopSchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyWorkshopSnapshots)
    .where(
      and(
        eq(t.accuracyWorkshopSnapshots.workspace_id, workspace_id),
        eq(t.accuracyWorkshopSnapshots.id, snapshot_id),
      ),
    )
    .limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function createWorkshopSnapshot(args: {
  workspace_id: string;
  actor: Actor;
  note?: string | null;
  scene?: WorkshopScene;
}): Promise<WorkshopSnapshotRecord> {
  const { inventory, readiness } = await workshopReadiness(args.workspace_id);
  if (!readiness.ready) {
    throw new Error(readiness.blockers[0] ?? "Workspace is not ready for workshop.");
  }
  const previous = await latestWorkshopSnapshot(args.workspace_id);
  const payload = emptyWorkshopPayload(inventory);
  if (previous) {
    payload.facilitator_tags = previous.payload.facilitator_tags;
  }
  payload.scene = args.scene ?? "gaps";
  const record = {
    id: newId("wss"),
    workspace_id: args.workspace_id,
    version: (previous?.version ?? 0) + 1,
    scene: payload.scene,
    payload,
    note: args.note?.trim() || null,
    saved_by: args.actor.name,
    saved_function: args.actor.function,
    saved_at: nowIso(),
  };
  await accuracyDb().insert(t.accuracyWorkshopSnapshots).values(record);
  return {
    id: record.id,
    workspace_id: record.workspace_id,
    version: record.version,
    scene: payload.scene,
    note: record.note,
    saved_by: record.saved_by,
    saved_function: record.saved_function,
    saved_at: record.saved_at,
    payload,
  };
}

async function persistPayload(record: WorkshopSnapshotRecord, payload: WorkshopSnapshotPayload) {
  await accuracyDb()
    .update(t.accuracyWorkshopSnapshots)
    .set({
      payload,
      scene: payload.scene,
    })
    .where(
      and(
        eq(t.accuracyWorkshopSnapshots.id, record.id),
        eq(t.accuracyWorkshopSnapshots.workspace_id, record.workspace_id),
      ),
    );
}

export async function setWorkshopScene(args: {
  workspace_id: string;
  snapshot_id: string;
  scene: WorkshopScene;
}): Promise<WorkshopSnapshotRecord> {
  const snapshot = await getWorkshopSnapshot(args.workspace_id, args.snapshot_id);
  if (!snapshot) throw new Error("Workshop snapshot not found in this workspace.");
  const payload = { ...snapshot.payload, scene: args.scene };
  await persistPayload(snapshot, payload);
  return { ...snapshot, scene: args.scene, payload };
}

export async function addFacilitatorTag(args: {
  workspace_id: string;
  snapshot_id: string;
  label: string;
}): Promise<WorkshopSnapshotRecord> {
  const snapshot = await getWorkshopSnapshot(args.workspace_id, args.snapshot_id);
  if (!snapshot) throw new Error("Workshop snapshot not found in this workspace.");
  const label = normalizeTagLabel(args.label);
  if (label.length < 2) throw new Error("Facilitator tag needs a short label.");
  const tags = snapshot.payload.facilitator_tags;
  if (tags.tags.some((tag) => tag.label.toLowerCase() === label.toLowerCase())) {
    throw new Error("A board with that tag already exists.");
  }
  const next: FacilitatorTagState = {
    tags: [...tags.tags, { id: newId("wtag"), label }],
    assignments: { ...tags.assignments },
  };
  const payload = { ...snapshot.payload, facilitator_tags: next };
  await persistPayload(snapshot, payload);
  return { ...snapshot, payload };
}

export async function assignFacilitatorTag(args: {
  workspace_id: string;
  snapshot_id: string;
  gap_id: string;
  tag_id: string;
}): Promise<WorkshopSnapshotRecord> {
  const snapshot = await getWorkshopSnapshot(args.workspace_id, args.snapshot_id);
  if (!snapshot) throw new Error("Workshop snapshot not found in this workspace.");
  const gap = snapshot.payload.inventory.gaps.find((row) => row.id === args.gap_id);
  if (!gap) throw new Error("Gap is not in this workshop snapshot.");
  const facilitator_tags = assignGapToTag(
    snapshot.payload.facilitator_tags,
    args.gap_id,
    args.tag_id || UNASSIGNED_BOARD_ID,
  );
  const payload = { ...snapshot.payload, facilitator_tags };
  await persistPayload(snapshot, payload);
  return { ...snapshot, payload };
}

function requireSnapshotGap(snapshot: WorkshopSnapshotRecord, gap_id: string): WorkshopGapLite {
  const gap = snapshot.payload.inventory.gaps.find((row) => row.id === gap_id);
  if (!gap) throw new Error("Gap is not in this workshop snapshot.");
  return gap;
}

function requireSnapshotTactic(snapshot: WorkshopSnapshotRecord, tactic_id: string): WorkshopTacticLite {
  const tactic = snapshot.payload.inventory.tactics.find((row) => row.id === tactic_id);
  if (!tactic) throw new Error("Tactic is not in this workshop snapshot.");
  return tactic;
}

export async function applyWorkshopAction(args: {
  workspace_id: string;
  snapshot_id: string;
  actor: Actor;
  action: WorkshopActionInput;
}): Promise<WorkshopSnapshotRecord> {
  const parsed = assertWorkshopAction(args.action);
  const snapshot = await getWorkshopSnapshot(args.workspace_id, args.snapshot_id);
  if (!snapshot) throw new Error("Workshop snapshot not found in this workspace.");
  requireSnapshotGap(snapshot, parsed.gap_id);

  const overlays: Record<string, WorkshopGapOverlay> = { ...snapshot.payload.overlays };
  const overlay: WorkshopGapOverlay = { ...(overlays[parsed.gap_id] ?? {}) };
  const detail: Record<string, unknown> = {};

  if (parsed.kind === "mark_addressed" && parsed.tactic_id) {
    requireSnapshotTactic(snapshot, parsed.tactic_id);
    await upsertCoverageDecision({
      workspace_id: args.workspace_id,
      gap_id: parsed.gap_id,
      tactic_id: parsed.tactic_id,
      overall: "covers",
      rationale: parsed.rationale,
    });
    overlay.coverage_status = "addressed";
    overlay.parked = false;
    detail.tactic_id = parsed.tactic_id;
    detail.overall = "covers";
    detail.ledger = "coverage";
  } else if (parsed.kind === "remap" && parsed.tactic_id && parsed.overall) {
    requireSnapshotTactic(snapshot, parsed.tactic_id);
    await upsertCoverageDecision({
      workspace_id: args.workspace_id,
      gap_id: parsed.gap_id,
      tactic_id: parsed.tactic_id,
      overall: parsed.overall,
      rationale: parsed.rationale,
    });
    overlay.coverage_status = coverageStatusAfterOverall(parsed.overall);
    detail.tactic_id = parsed.tactic_id;
    detail.overall = parsed.overall;
    detail.ledger = "coverage";
  } else if (parsed.kind === "set_priority" && parsed.priority) {
    const claim = await getClaim(args.workspace_id, parsed.gap_id);
    if (!claim) throw new Error("Gap not found in this workspace.");
    const meta = claimMetadata(claim);
    await updateClaimMetadata({
      workspace_id: args.workspace_id,
      claim_id: parsed.gap_id,
      metadata: {
        ...meta,
        priority: parsed.priority,
        priority_rationale: parsed.rationale,
        priority_origin: "workshop",
      },
    });
    overlay.priority = parsed.priority;
    overlay.priority_rationale = parsed.rationale;
    detail.priority = parsed.priority;
    detail.ledger = "priority";
  } else if (parsed.kind === "park") {
    overlay.parked = true;
    overlay.park_rationale = parsed.rationale;
    overlay.parked_at = nowIso();
    overlay.parked_by = args.actor.name;
    detail.ledger = "none";
  }

  overlays[parsed.gap_id] = overlay;
  const log: WorkshopActionLog = {
    id: newId("wact"),
    kind: parsed.kind,
    gap_id: parsed.gap_id,
    rationale: parsed.rationale,
    origin: "workshop",
    at: nowIso(),
    by: args.actor.name,
    detail,
  };
  const payload: WorkshopSnapshotPayload = {
    ...snapshot.payload,
    overlays,
    actions: [...snapshot.payload.actions, log],
  };
  await persistPayload(snapshot, payload);
  return { ...snapshot, payload };
}

export { isLiveWorkshopGap, evaluateWorkshopReadiness };
