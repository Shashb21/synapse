import { z } from "zod";
import { GAP_STATUSES, MAPPED_GAP_STATUSES } from "@/lib/iegp/enums";
import { priorityReviewExclusion } from "@/modules/stages/s8-prioritization/review-basis";
import { axesConfigSchema } from "@/modules/stages/s8-prioritization/axes";
import type { DecisionExample } from "./decision-examples";
import { evidenceHash, frozenReplayCase } from "./decision-replay";
import type { FrozenReplayCase } from "./decision-replay";
import type { ResolvedRoute } from "./contracts";
import { assertEvaluationRoute } from "./evaluation-isolation";

export const REVISION_PROTOCOL = { version: 4, minimum_cases: 3, repeats: 3, margin: 0.1, minimum_reviewers: 2 } as const;
export const TARGET_STAGES = ["S8"] as const;
const bands = ["high", "medium", "low", "defer"];
const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
function normalized(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    : "";
}
function contentKey(value: unknown) {
  const text = normalized(value);
  return text.split(" ").length >= 3 ? "content:" + evidenceHash(text) : null;
}
export function subjectFingerprint(example: DecisionExample) {
  return contentKey(record(example.ai_input.gap).statement);
}
export function routeIdentity(route: ResolvedRoute): string {
  return evidenceHash({
    stage: route.stage,
    provider_id: route.provider_id,
    model: route.model,
    params: route.params,
    fallbacks: route.fallbacks,
  });
}

function idSet(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((v) => typeof v === "string" && v.trim()) &&
    new Set(value).size === value.length
    ? [...value].sort()
    : null;
}
/** Only explicit changed categorical targets or a reasoned human rejection can define gold. */
export function targetMetrics(example: DecisionExample): string[] {
  const reviewer = example.actor_principal?.trim().toLowerCase();
  if (!reviewer || /^(anonymous|demo|system)(:|$)/.test(reviewer) || example.outcome === "accepted") return [];
  const original = example.ai_output,
    final = example.final;
  if (example.stage !== "S8" || example.kind !== "s8_band" || example.outcome !== "edited" || !final) return [];
  if (example.replay_exclusion_reason || priorityReviewExclusion(example.priority_review_hash, frozenReplayCase(example), example.subject_id)) return [];
  return bands.includes(String(final.band)) && bands.includes(String(original.band)) && final.band !== original.band
    ? ["band_agreement"]
    : [];
}

export function identityKeys(example: DecisionExample): Set<string> {
  const fingerprint = subjectFingerprint(example);
  return new Set([
    `decision:${example.id}`,
    ...(frozenReplayCase(example)?.examples ?? []).map((worked) => `decision:${worked.id}`),
    `id:${example.subject_id}`,
    ...(example.run_id ? [`run:${example.run_id}`] : []),
    ...(fingerprint ? [fingerprint] : []),
  ]);
}

const identifier = z.string().trim().min(1);
const stateLineageSchema = z.object({
  asset: z.object({ id: identifier }),
  objectives: z.array(z.object({ id: identifier })),
  gaps: z.array(
    z.object({
      id: identifier,
      statement: z.string(),
      status: z.enum(GAP_STATUSES),
      computed_status: z.enum(MAPPED_GAP_STATUSES).nullable(),
      status_override: z.object({ status: z.enum(MAPPED_GAP_STATUSES) }).nullable(),
      parked_at: z.string().nullable(),
      retired: z.boolean(),
      parent_gap_id: identifier.nullable(),
      origin_gap_id: identifier.nullable(),
      related_gap_ids: z.array(identifier),
    }),
  ),
  needs: z.array(
    z.object({
      id: identifier,
      statement: z.string(),
      source_quote: z.string(),
      source_id: identifier,
      run_id: identifier.nullable(),
    }),
  ),
  need_gap_links: z.array(z.object({ gap_id: identifier, need_id: identifier, role: z.enum(["primary", "supporting"]) })),
  sources: z.array(z.object({ id: identifier, full_text: z.string() })),
  gap_versions: z.array(
    z.object({
      id: identifier,
      live_gap_id: identifier,
      retired_gap_id: identifier,
      statement: z.string(),
      snapshot: z.object({ related_gap_ids: z.array(identifier) }).nullish(),
    }),
  ),
});

/** Require the emitted S8 lineage envelope; omitted arrays cannot establish an empty history. */
function originatingKeys(example: DecisionExample): Set<string> | null {
  const snapshot = frozenReplayCase(example);
  if (
    !snapshot ||
    snapshot.stage !== "S8" ||
    !example.run_id ||
    !subjectFingerprint(example) ||
    snapshot.execution !== "routed" ||
    snapshot.route.stage !== example.stage ||
    !snapshot.prompt_version ||
    example.replay_exclusion_reason
  )
    return null;
  try {
    assertEvaluationRoute(snapshot.route);
  } catch {
    return null;
  }
  const parsed = stateLineageSchema.safeParse(snapshot.facts.state);
  if (!parsed.success || !axesConfigSchema.safeParse(snapshot.facts.axesConfig).success) return null;
  const { gaps, needs, need_gap_links: links, sources, gap_versions: versions } = parsed.data;
  for (const rows of [gaps, needs, sources, versions])
    if (new Set(rows.map((row) => row.id)).size !== rows.length) return null;
  const ids = record(snapshot.input).gap_ids;
  if (ids != null && !idSet(ids)) return null;
  const selected = Array.isArray(ids) && ids.length ? gaps.filter((g) => ids.includes(g.id)) : gaps;
  if (!selected.length || (Array.isArray(ids) && ids.length && selected.length !== ids.length)) return null;
  const keys = identityKeys(example);
  const queue = new Set(selected.map((gap) => gap.id));
  for (const id of queue) {
    if (typeof id !== "string") return null;
    keys.add("id:" + id);
    const gap = gaps.find((row) => row.id === id);
    if (gap) {
      const key = contentKey(gap.statement);
      if (!key) return null;
      keys.add(key);
      if (!gap.retired && !links.some((link) => link.gap_id === gap.id)) return null;
      const related = gap.related_gap_ids;
      for (const other of [gap.parent_gap_id, gap.origin_gap_id, ...related])
        if (typeof other === "string") queue.add(other);
    }
    for (const v of versions.filter((v) => v.live_gap_id === id || v.retired_gap_id === id)) {
      if (typeof v.live_gap_id !== "string" || typeof v.retired_gap_id !== "string") return null;
      queue.add(v.live_gap_id);
      queue.add(v.retired_gap_id);
      const key = contentKey(v.statement);
      if (key) keys.add(key);
      const related = record(v.snapshot).related_gap_ids;
      if (Array.isArray(related)) for (const other of related) if (typeof other === "string") queue.add(other);
    }
    for (const link of links.filter((link) => link.gap_id === id)) {
      const need = needs.find((row) => row.id === link.need_id);
      if (!need || typeof need.id !== "string" || typeof need.source_id !== "string") return null;
      keys.add("need:" + need.id);
      if (typeof need.run_id === "string") keys.add("run:" + need.run_id);
      for (const text of [need.statement, need.source_quote]) {
        const key = contentKey(text);
        if (key) keys.add(key);
      }
      const source = sources.find((row) => row.id === need.source_id);
      if (!source) return null;
      if (need.source_id === "SRC-PLAN-ENTRY") continue;
      const fingerprint = contentKey(source.full_text);
      if (!fingerprint) return null;
      keys.add("source:" + need.source_id);
      keys.add("document:" + fingerprint);
    }
  }
  const subject = example.subject_id;
  const gap = selected.find((g) => g.id === subject);
  if (!gap || gap.retired || gap.parked_at || ["candidate", "excluded"].includes(gap.status)) return null;
  if ((gap.status_override?.status ?? gap.computed_status ?? gap.status) !== "validated_open") return null;
  if (contentKey(gap.statement) !== subjectFingerprint(example)) return null;
  return keys;
}

/** Follow every worked example to its own originating execution. Foreign, missing or cyclic ancestry is unproven. */
export function lineageResolver(examples: DecisionExample[]) {
  const byId = new Map(examples.map((row) => [row.id, row]));
  const cache = new Map<string, Set<string> | null>();
  function resolve(example: DecisionExample): Set<string> | null {
    if (cache.has(example.id)) return cache.get(example.id)!;
    cache.set(example.id, null);
    const keys = originatingKeys(example);
    if (!keys) return null;
    for (const hint of frozenReplayCase(example)!.examples) {
      const source = byId.get(hint.id);
      if (
        hint.scope !== "this_plan" ||
        !source ||
        source.workspace_id !== example.workspace_id ||
        source.stage !== example.stage ||
        source.kind !== hint.kind
      )
        return null;
      const upstream = resolve(source);
      if (!upstream) return null;
      for (const key of upstream) keys.add(key);
    }
    cache.set(example.id, keys);
    return keys;
  }
  return resolve;
}

export function executionLineage(example: DecisionExample) {
  return lineageResolver([example])(example);
}

export function lineageGroups(examples: DecisionExample[]): DecisionExample[][] {
  const groups: { keys: Set<string>; rows: DecisionExample[] }[] = [];
  const resolve = lineageResolver(examples);
  for (const example of examples) {
    const keys = new Set(resolve(example) ?? identityKeys(example));
    const hits = groups.filter((group) => [...keys].some((k) => group.keys.has(k)));
    const rows = [example];
    for (const hit of hits) {
      rows.push(...hit.rows);
      for (const key of hit.keys) keys.add(key);
      groups.splice(groups.indexOf(hit), 1);
    }
    groups.push({ keys, rows });
  }
  return groups.map((group) =>
    group.rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)),
  );
}

export type ReservedTarget = {
  id: string;
  fingerprint: string;
  run_id: string;
  metrics: string[];
  snapshot_hash: string;
  target_hash: string;
};
export function reservedTarget(example: DecisionExample, snapshot: FrozenReplayCase): ReservedTarget {
  return {
    id: example.id,
    fingerprint: subjectFingerprint(example)!,
    run_id: snapshot.run_id,
    metrics: targetMetrics(example),
    snapshot_hash: evidenceHash({ ...snapshot, examples: [] }),
    target_hash: evidenceHash([example.outcome, example.final, example.rationale, example.actor_principal]),
  };
}

export function scoreHumanTarget(
  example: DecisionExample,
  p: import("./decision-replay").DecisionProjection | null,
): Record<string, number> {
  if (!p || p.subject_id !== example.subject_id || p.kind !== example.kind)
    throw new Error("Missing an unambiguous decision for the frozen target.");
  const names = targetMetrics(example);
  if (!names.length) throw new Error("No independent human target.");
  return { band_agreement: Number(p.decision === "accept" && p.band === example.final!.band) };
}
