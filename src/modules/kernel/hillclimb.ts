import { and, desc, eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import type { HillclimbSignalDraft, HillclimbSignalKind, StageId } from "./contracts";

export type HillclimbSignal = {
  id: string;
  at: string;
  stage: StageId;
  kind: HillclimbSignalKind;
  subject: string;
  rationale: string;
  weight: number;
  status: "open" | "applied" | "dismissed";
  payload: unknown;
};

export async function recordSignal(draft: HillclimbSignalDraft): Promise<HillclimbSignal> {
  await ensurePlatformSchema();
  const signal: HillclimbSignal = {
    id: newId("hc"),
    at: nowIso(),
    stage: draft.stage,
    kind: draft.kind,
    subject: draft.subject,
    rationale: draft.rationale.trim(),
    weight: draft.weight ?? 1,
    status: "open",
    payload: draft.payload ?? null,
  };
  await db().insert(t.hillclimbSignals).values({
    id: signal.id,
    at: signal.at,
    stage: signal.stage,
    kind: signal.kind,
    subject: signal.subject,
    rationale: signal.rationale,
    weight: signal.weight,
    status: signal.status,
    payload: signal.payload,
  });
  return signal;
}

function toSignal(row: typeof t.hillclimbSignals.$inferSelect): HillclimbSignal {
  return {
    id: row.id,
    at: row.at,
    stage: row.stage as StageId,
    kind: row.kind as HillclimbSignalKind,
    subject: row.subject,
    rationale: row.rationale,
    weight: row.weight,
    status: row.status as HillclimbSignal["status"],
    payload: row.payload,
  };
}

export async function listSignals(args?: {
  stage?: StageId;
  status?: HillclimbSignal["status"];
  limit?: number;
}): Promise<HillclimbSignal[]> {
  await ensurePlatformSchema();
  const limit = args?.limit ?? 200;
  const filters = [
    args?.stage ? eq(t.hillclimbSignals.stage, args.stage) : undefined,
    args?.status ? eq(t.hillclimbSignals.status, args.status) : undefined,
  ].filter(Boolean);
  const query = db().select().from(t.hillclimbSignals);
  const rows = filters.length
    ? await query
        .where(filters.length === 1 ? filters[0] : and(...filters))
        .orderBy(desc(t.hillclimbSignals.at))
        .limit(limit)
    : await query.orderBy(desc(t.hillclimbSignals.at)).limit(limit);
  return rows.map(toSignal);
}

export async function setSignalStatus(id: string, status: HillclimbSignal["status"]) {
  await ensurePlatformSchema();
  await db().update(t.hillclimbSignals).set({ status }).where(eq(t.hillclimbSignals.id, id));
}

export type HillclimbDigest = {
  stage: StageId;
  open: number;
  /** Rationale lines the stage feeds back into its prompts, newest first. */
  corrections: string[];
  by_kind: Record<string, number>;
};

/**
 * What an agentic stage reads before it proposes: the user's own rationales for
 * previous corrections at this stage. This is the hillclimb feedback path.
 */
export async function hillclimbDigest(stage: StageId, take = 8): Promise<HillclimbDigest> {
  const signals = await listSignals({ stage, status: "open", limit: 200 });
  const by_kind: Record<string, number> = {};
  for (const signal of signals) {
    by_kind[signal.kind] = (by_kind[signal.kind] ?? 0) + 1;
  }
  const seen = new Set<string>();
  const corrections: string[] = [];
  for (const signal of signals) {
    const line = signal.rationale.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    corrections.push(line);
    if (corrections.length >= take) break;
  }
  return { stage, open: signals.length, corrections, by_kind };
}

/** Renders the digest as prompt text. Empty string when there is nothing learned yet. */
export function digestAsPrompt(digest: HillclimbDigest): string {
  if (digest.corrections.length === 0) return "";
  return [
    "Reviewer corrections from earlier runs of this stage. Respect them:",
    ...digest.corrections.map((line) => `- ${line}`),
  ].join("\n");
}
