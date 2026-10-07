/**
 * Human edits on ledger claims: manual create, field-level edit with a
 * required rationale, audit trail (`metadata.edit_history`) and human locks
 * (`metadata.human_locked`). AI writers call `preserveHumanLocks` so a re-run
 * never clobbers what a human set by hand.
 */
import { and, eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import {
  claimMetadata,
  getClaim,
  insertClaim,
  requireValidationRationale,
  type AccuracyClaimMetadata,
  type AccuracyClaimRow,
  type AccuracyClaimType,
  type ClaimEditAction,
  type ClaimEditEntry,
} from "./claim-store";

export const GAP_STATUS_OVERRIDES = ["open", "partial", "addressed"] as const;
export type GapStatusOverride = (typeof GAP_STATUS_OVERRIDES)[number];

export const CLAIM_PRIORITIES = ["high", "medium", "low", "critical", "gated", "addressed"] as const;
export type ClaimPriority = (typeof CLAIM_PRIORITIES)[number];

/** Editable claim fields. Tactic-only and gap-only fields are rejected on the wrong type. */
export type ClaimPatch = {
  statement?: string;
  external_id?: string | null;
  /** Replaces the quote of the first provenance span (creates a manual span when none). */
  provenance_quote?: string | null;
  priority?: ClaimPriority;
  /** Gap only. `null` clears a previous override. */
  status_override?: GapStatusOverride | null;
  /** Tactic only. */
  type?: (typeof TACTIC_TYPES)[number] | null;
  tactic_status?: (typeof TACTIC_STATUSES)[number];
  evidence_question?: string | null;
  design_summary?: string | null;
  start?: string | null;
  end?: string | null;
  readout?: string | null;
  depends_on?: string[];
};

export type ClaimPatchField = keyof ClaimPatch;

export const CLAIM_PATCH_FIELDS: ClaimPatchField[] = [
  "statement",
  "external_id",
  "provenance_quote",
  "priority",
  "status_override",
  "type",
  "tactic_status",
  "evidence_question",
  "design_summary",
  "start",
  "end",
  "readout",
  "depends_on",
];

const TACTIC_ONLY_FIELDS: ClaimPatchField[] = [
  "type",
  "tactic_status",
  "evidence_question",
  "design_summary",
  "start",
  "end",
  "readout",
  "depends_on",
];
const GAP_ONLY_FIELDS: ClaimPatchField[] = ["status_override"];

/** Lock name → metadata keys it guards (statement is a column, guarded by merge protection). */
const LOCK_META_KEYS: Record<string, string[]> = {
  external_id: ["external_id"],
  provenance_quote: ["provenance"],
  provenance: ["provenance"],
  priority: ["priority", "priority_rationale", "priority_band", "priority_origin"],
  status_override: ["status_override"],
  type: ["type", "tactic_type"],
  tactic_status: ["tactic_status"],
  evidence_question: ["evidence_question"],
  design_summary: ["design_summary"],
  start: ["start"],
  end: ["end"],
  readout: ["readout", "readout_date", "evidence_available"],
  depends_on: ["depends_on"],
  statement: [],
  merge: [],
};

/** Human bookkeeping keys an AI writer must never drop. */
const HUMAN_BOOKKEEPING_KEYS = [
  "human_locked",
  "edit_history",
  "last_human_edit",
  "merge_rejected_with",
  "validation",
];

export function humanLockedFields(meta: AccuracyClaimMetadata): string[] {
  return Array.isArray(meta.human_locked)
    ? meta.human_locked.filter((key): key is string => typeof key === "string")
    : [];
}

export function isHumanEditedClaim(claim: Pick<AccuracyClaimRow, "metadata">): boolean {
  return humanLockedFields((claim.metadata ?? {}) as AccuracyClaimMetadata).length > 0;
}

/**
 * Validated or human-edited claims are protected: AI re-runs may propose
 * changes (e.g. a merge) but never apply them.
 */
export function isHumanProtectedClaim(
  claim: Pick<AccuracyClaimRow, "validated" | "status" | "metadata">,
): boolean {
  return claim.validated || claim.status === "validated" || isHumanEditedClaim(claim);
}

/**
 * For AI writers: take `next` metadata but restore every human-locked field
 * (and the human bookkeeping keys) from `prev`.
 */
export function preserveHumanLocks(
  prev: AccuracyClaimMetadata,
  next: AccuracyClaimMetadata,
): AccuracyClaimMetadata {
  const out: AccuracyClaimMetadata = { ...next };
  for (const lock of humanLockedFields(prev)) {
    for (const key of LOCK_META_KEYS[lock] ?? [lock]) {
      if (key in prev) out[key] = prev[key];
      else delete out[key];
    }
  }
  for (const key of HUMAN_BOOKKEEPING_KEYS) {
    if (key in prev) out[key] = prev[key];
  }
  return out;
}

/** Pair keys (a::b, sorted) a human marked as "not the same item". */
export function mergeRejectedPairs(
  claims: Array<Pick<AccuracyClaimRow, "id" | "metadata">>,
): Set<string> {
  const out = new Set<string>();
  for (const claim of claims) {
    const meta = (claim.metadata ?? {}) as AccuracyClaimMetadata;
    const others = Array.isArray(meta.merge_rejected_with) ? meta.merge_rejected_with : [];
    for (const other of others) {
      if (typeof other !== "string" || !other) continue;
      out.add(claim.id <= other ? `${claim.id}::${other}` : `${other}::${claim.id}`);
    }
  }
  return out;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeClaimDate(field: string, value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const day = trimmed.slice(0, 10);
  if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`${field} must be a date (YYYY-MM-DD).`);
  }
  return day;
}

function optionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function firstProvenanceQuote(meta: AccuracyClaimMetadata): string | null {
  if (!Array.isArray(meta.provenance)) return null;
  const first = meta.provenance[0] as { quote?: unknown } | undefined;
  return typeof first?.quote === "string" ? first.quote : null;
}

function currentFieldValue(
  current: { statement: string; metadata: AccuracyClaimMetadata },
  field: ClaimPatchField,
): unknown {
  const meta = current.metadata;
  switch (field) {
    case "statement":
      return current.statement;
    case "provenance_quote":
      return firstProvenanceQuote(meta);
    case "status_override":
      return meta.status_override && typeof meta.status_override === "object"
        ? meta.status_override.status
        : null;
    case "type":
      return meta.type ?? meta.tactic_type ?? null;
    case "readout":
      return meta.readout ?? meta.readout_date ?? null;
    case "depends_on":
      return Array.isArray(meta.depends_on) ? meta.depends_on : [];
    default:
      return meta[field] ?? null;
  }
}

export type ClaimPatchContext = {
  claim_id: string;
  claim_type: AccuracyClaimType;
  source_file_id: string | null;
  rationale: string;
  actor: Actor;
  at: string;
  /** Tactic ids that exist in the workspace (for depends_on validation). */
  tactic_ids: Set<string>;
};

/**
 * Validate + apply a patch onto (statement, metadata). Returns only the fields
 * that actually changed. Pure — no DB writes.
 */
export function applyClaimPatch(
  current: { statement: string; metadata: AccuracyClaimMetadata },
  patch: ClaimPatch,
  ctx: ClaimPatchContext,
): {
  statement: string;
  metadata: AccuracyClaimMetadata;
  changed: ClaimPatchField[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
} {
  const fields = (Object.keys(patch) as ClaimPatchField[]).filter(
    (key) => patch[key] !== undefined,
  );
  for (const field of fields) {
    if (!CLAIM_PATCH_FIELDS.includes(field)) throw new Error(`Unknown field: ${field}`);
    if (ctx.claim_type === "gap" && TACTIC_ONLY_FIELDS.includes(field)) {
      throw new Error(`${field} can only be set on a tactic.`);
    }
    if (ctx.claim_type === "tactic" && GAP_ONLY_FIELDS.includes(field)) {
      throw new Error(`${field} can only be set on a gap.`);
    }
  }

  const snapshot = { statement: current.statement, metadata: current.metadata };
  let statement = current.statement;
  const meta: AccuracyClaimMetadata = { ...current.metadata };
  const changed: ClaimPatchField[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  const record = (field: ClaimPatchField, next: unknown) => {
    const prev = currentFieldValue(snapshot, field);
    if (valuesEqual(prev, next)) return false;
    changed.push(field);
    before[field] = prev ?? null;
    after[field] = next ?? null;
    return true;
  };

  if (patch.statement !== undefined) {
    const next = patch.statement.trim();
    if (!next) throw new Error("Statement cannot be empty.");
    if (record("statement", next)) statement = next;
  }
  if (patch.external_id !== undefined) {
    const next = optionalText(patch.external_id);
    if (record("external_id", next)) meta.external_id = next;
  }
  if (patch.provenance_quote !== undefined) {
    const next = optionalText(patch.provenance_quote);
    if (record("provenance_quote", next)) {
      const spans = Array.isArray(meta.provenance) ? [...(meta.provenance as unknown[])] : [];
      if (next == null) {
        spans.shift();
      } else if (spans.length > 0 && spans[0] && typeof spans[0] === "object") {
        spans[0] = { ...(spans[0] as Record<string, unknown>), quote: next, edited_by_human: true };
      } else {
        spans.unshift({
          source_file_id: ctx.source_file_id ?? "manual",
          block_id: `manual:${ctx.claim_id}`,
          quote: next,
          edited_by_human: true,
        });
      }
      meta.provenance = spans;
    }
  }
  if (patch.priority !== undefined) {
    if (!(CLAIM_PRIORITIES as readonly string[]).includes(patch.priority)) {
      throw new Error(`Unknown priority: ${patch.priority}`);
    }
    if (record("priority", patch.priority)) {
      meta.priority = patch.priority;
      meta.priority_rationale = ctx.rationale;
      meta.priority_origin = "human";
    }
  }
  if (patch.status_override !== undefined) {
    const next = patch.status_override;
    if (next !== null && !(GAP_STATUS_OVERRIDES as readonly string[]).includes(next)) {
      throw new Error(
        `status_override must be one of ${GAP_STATUS_OVERRIDES.join(", ")} or null.`,
      );
    }
    if (record("status_override", next)) {
      meta.status_override =
        next === null
          ? null
          : {
              status: next,
              rationale: ctx.rationale,
              at: ctx.at,
              by: ctx.actor.name,
              by_function: ctx.actor.function,
            };
    }
  }
  if (patch.type !== undefined) {
    const next = patch.type;
    if (next !== null && !(TACTIC_TYPES as readonly string[]).includes(next)) {
      throw new Error(`Unknown tactic type: ${next}`);
    }
    if (record("type", next)) {
      meta.type = next;
      meta.tactic_type = next;
    }
  }
  if (patch.tactic_status !== undefined) {
    if (!(TACTIC_STATUSES as readonly string[]).includes(patch.tactic_status)) {
      throw new Error(`Unknown tactic status: ${patch.tactic_status}`);
    }
    if (record("tactic_status", patch.tactic_status)) meta.tactic_status = patch.tactic_status;
  }
  if (patch.evidence_question !== undefined) {
    const next = optionalText(patch.evidence_question);
    if (record("evidence_question", next)) meta.evidence_question = next;
  }
  if (patch.design_summary !== undefined) {
    const next = optionalText(patch.design_summary);
    if (record("design_summary", next)) meta.design_summary = next;
  }
  if (patch.start !== undefined) {
    const next = normalizeClaimDate("start", patch.start);
    if (record("start", next)) meta.start = next;
  }
  if (patch.end !== undefined) {
    const next = normalizeClaimDate("end", patch.end);
    if (record("end", next)) meta.end = next;
  }
  if (patch.readout !== undefined) {
    const next = normalizeClaimDate("readout", patch.readout);
    if (record("readout", next)) {
      meta.readout = next;
      delete meta.readout_date;
    }
  }
  if (patch.depends_on !== undefined) {
    const next = [...new Set(patch.depends_on.map((id) => id.trim()).filter(Boolean))].sort();
    for (const id of next) {
      if (id === ctx.claim_id) throw new Error("A tactic cannot depend on itself.");
      if (!ctx.tactic_ids.has(id)) throw new Error(`depends_on: unknown tactic ${id}`);
    }
    if (record("depends_on", next)) meta.depends_on = next;
  }

  const start = typeof meta.start === "string" ? meta.start.slice(0, 10) : null;
  const end = typeof meta.end === "string" ? meta.end.slice(0, 10) : null;
  if (start && end && end < start) {
    throw new Error("End date must be on or after the start date.");
  }

  return { statement, metadata: meta, changed, before, after };
}

/** Append an audit entry + human-lock fields. Returns new metadata (pure). */
export function withHumanEdit(
  meta: AccuracyClaimMetadata,
  entry: {
    action: ClaimEditAction;
    fields: string[];
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    rationale: string;
    actor: Actor;
    at?: string;
    /** Locks to add; defaults to `fields`. */
    lock?: string[];
  },
): AccuracyClaimMetadata {
  const at = entry.at ?? nowIso();
  const history = Array.isArray(meta.edit_history) ? meta.edit_history : [];
  const locks = new Set([...humanLockedFields(meta), ...(entry.lock ?? entry.fields)]);
  const row: ClaimEditEntry = {
    id: newId("cedit"),
    action: entry.action,
    fields: entry.fields,
    before: entry.before,
    after: entry.after,
    rationale: entry.rationale,
    at,
    by: entry.actor.name,
    by_function: entry.actor.function,
  };
  return {
    ...meta,
    human_locked: [...locks].sort(),
    edit_history: [...history, row],
    last_human_edit: { at, by: entry.actor.name, action: entry.action, rationale: entry.rationale },
  };
}

async function workspaceTacticIds(workspace_id: string): Promise<Set<string>> {
  const rows = await accuracyDb()
    .select({ id: t.accuracyClaims.id, claim_type: t.accuracyClaims.claim_type })
    .from(t.accuracyClaims)
    .where(eq(t.accuracyClaims.workspace_id, workspace_id));
  return new Set(rows.filter((row) => row.claim_type === "tactic").map((row) => row.id));
}

/** Write statement/status/metadata for one claim (no lock logic — callers decide). */
export async function writeClaimRow(args: {
  workspace_id: string;
  claim: AccuracyClaimRow;
  statement?: string;
  status?: string;
  metadata: AccuracyClaimMetadata;
  at?: string;
}): Promise<AccuracyClaimRow> {
  const at = args.at ?? nowIso();
  const statement = args.statement ?? args.claim.statement;
  const status = args.status ?? args.claim.status;
  await accuracyDb()
    .update(t.accuracyClaims)
    .set({ statement, status, metadata: args.metadata as Record<string, unknown>, updated_at: at })
    .where(
      and(
        eq(t.accuracyClaims.id, args.claim.id),
        eq(t.accuracyClaims.workspace_id, args.workspace_id),
      ),
    );
  return {
    ...args.claim,
    statement,
    status,
    metadata: args.metadata as Record<string, unknown>,
    updated_at: at,
  };
}

/**
 * Human edit of a claim's statement and metadata fields. Rationale required;
 * every changed field is recorded in `edit_history` and human-locked so AI
 * re-runs (extract / merge / status-derive / gantt) never clobber it.
 */
export async function updateClaim(args: {
  workspace_id: string;
  claim_id: string;
  patch: ClaimPatch;
  rationale: string;
  actor: Actor;
}): Promise<{ claim: AccuracyClaimRow; changed: ClaimPatchField[] }> {
  const rationale = requireValidationRationale(args.rationale);
  await ensureAccuracySchema();
  const existing = await getClaim(args.workspace_id, args.claim_id);
  if (!existing) throw new Error(`Unknown claim: ${args.claim_id}`);
  if (existing.claim_type !== "gap" && existing.claim_type !== "tactic") {
    throw new Error(`Unsupported claim type: ${existing.claim_type}`);
  }
  const at = nowIso();
  const applied = applyClaimPatch(
    { statement: existing.statement, metadata: claimMetadata(existing) },
    args.patch,
    {
      claim_id: existing.id,
      claim_type: existing.claim_type,
      source_file_id: existing.source_file_id,
      rationale,
      actor: args.actor,
      at,
      tactic_ids: args.patch.depends_on?.length
        ? await workspaceTacticIds(args.workspace_id)
        : new Set(),
    },
  );
  if (applied.changed.length === 0) {
    throw new Error("No changes to save.");
  }
  const metadata = withHumanEdit(applied.metadata, {
    action: "edit",
    fields: applied.changed,
    before: applied.before,
    after: applied.after,
    rationale,
    actor: args.actor,
    at,
  });
  let status = existing.status;
  if (
    applied.changed.includes("tactic_status") &&
    (TACTIC_STATUSES as readonly string[]).includes(existing.status)
  ) {
    status = String(metadata.tactic_status);
  }
  const claim = await writeClaimRow({
    workspace_id: args.workspace_id,
    claim: existing,
    statement: applied.statement,
    status,
    metadata,
    at,
  });
  return { claim, changed: applied.changed };
}

/**
 * Create a claim by hand (no AI). Origin `manual` by default; every supplied
 * field is human-locked and the create is recorded in `edit_history`.
 */
export async function createManualClaim(args: {
  workspace_id: string;
  claim_type: AccuracyClaimType;
  statement: string;
  rationale: string;
  actor: Actor;
  fields?: Omit<ClaimPatch, "statement">;
  source_file_id?: string | null;
  metadata?: AccuracyClaimMetadata;
  origin?: string;
  source_badge?: string;
  action?: ClaimEditAction;
  status?: string;
}): Promise<AccuracyClaimRow> {
  const rationale = requireValidationRationale(args.rationale);
  const statement = args.statement.trim();
  if (!statement) throw new Error("Statement is required.");
  if (args.claim_type !== "gap" && args.claim_type !== "tactic") {
    throw new Error(`Unsupported claim type: ${String(args.claim_type)}`);
  }
  await ensureAccuracySchema();
  const id = newId(args.claim_type === "gap" ? "gap" : "tac");
  const at = nowIso();
  const base: AccuracyClaimMetadata = {
    ...(args.metadata ?? {}),
    origin: args.origin ?? "manual",
    source_badge: args.source_badge ?? "manual",
  };
  const fields = args.fields ?? {};
  const applied = applyClaimPatch({ statement, metadata: base }, fields, {
    claim_id: id,
    claim_type: args.claim_type,
    source_file_id: args.source_file_id ?? null,
    rationale,
    actor: args.actor,
    at,
    tactic_ids: fields.depends_on?.length ? await workspaceTacticIds(args.workspace_id) : new Set(),
  });
  const metadata = withHumanEdit(applied.metadata, {
    action: args.action ?? "create",
    fields: ["statement", ...applied.changed],
    before: {},
    after: { statement, ...applied.after },
    rationale,
    actor: args.actor,
    at,
  });
  const defaultStatus =
    args.claim_type === "tactic" && typeof metadata.tactic_status === "string"
      ? metadata.tactic_status
      : "draft";
  return insertClaim({
    id,
    workspace_id: args.workspace_id,
    claim_type: args.claim_type,
    statement,
    status: args.status ?? defaultStatus,
    validated: false,
    source_file_id: args.source_file_id ?? null,
    metadata,
  });
}
