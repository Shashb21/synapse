/** Compare source blocks with snapshot items and validate model supplied omission evidence. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonCompletion } from "@/accuracy/kernel/contracts";
import type { AuditBlockLite } from "./engine";

/** A current snapshot gap or tactic and its source provenance. */
export type SnapshotItem = {
  item_kind: "gap" | "tactic";
  item_ref: string;
  statement: string;
  provenance: Array<{ source_file_id: string; block_id: string; quote: string }>;
};

/** A source-supported item that may be missing from the snapshot. */
export type SuspectedOmission = {
  issue_id: string;
  item_kind: "gap" | "tactic";
  summary: string;
  source_ref: { source_file_id: string; block_id: string };
  evidence_quote: string;
  basis: "explicit" | "inferred";
  importance: "important" | "advisory";
  reason: string;
  suggested_action: string;
};

/** The current disposition of an omission reported in an earlier inspection. */
export type OmissionResolution = {
  issue_id: string;
  outcome: "unresolved" | "partly_resolved" | "resolved" | "invalid";
  reason: string;
  matched_item_ref?: string;
};

/** Source scope, findings, and risk produced by one inspection. */
export type SnapshotCompletenessAssessment = {
  risk_level: "not_applicable" | "none_detected" | "advisory" | "important" | "check_failed";
  checked_block_ids: string[];
  unchecked_block_ids: string[];
  suspected_omissions: SuspectedOmission[];
  prior_issue_resolutions: OmissionResolution[];
};

const nonempty = z.string().trim().min(1);
const findingSchema = z.object({
  item_kind: z.enum(["gap", "tactic"]),
  summary: nonempty,
  source_ref: z.object({ source_file_id: nonempty, block_id: nonempty }),
  evidence_quote: nonempty,
  basis: z.enum(["explicit", "inferred"]),
  reason: nonempty,
  suggested_action: nonempty,
});
const responseSchema = z.object({
  suspected_omissions: z.array(findingSchema),
  prior_issue_resolutions: z.array(z.unknown()),
  checked_block_ids: z.array(z.string()),
});
const dispositionSchema = z.object({
  issue_id: nonempty,
  outcome: z.enum(["resolved", "partly_resolved", "invalid", "unresolved"]),
  reason: nonempty,
  matched_item_ref: nonempty.optional(),
});

/** Keep the legacy evidence key as the base for newly allocated issue IDs. */
function evidenceIdentity(issue: Pick<SuspectedOmission, "item_kind" | "source_ref" | "evidence_quote">): string {
  return JSON.stringify([issue.source_ref.source_file_id, issue.source_ref.block_id, issue.item_kind, issue.evidence_quote]);
}

/** Match an exact repeated finding without merging distinct items sharing evidence. */
function findingIdentity(issue: Pick<SuspectedOmission, "item_kind" | "source_ref" | "evidence_quote" | "summary">): string {
  return JSON.stringify([evidenceIdentity(issue), issue.summary.trim()]);
}

/** Keep a prior issue open when its disposition cannot be validated. */
function unresolved(issue_id: string): OmissionResolution {
  return { issue_id, outcome: "unresolved", reason: "No valid explicit disposition was supplied." };
}

/** Inspect every eligible block against current items, retaining evidence when inspection fails. */
export async function inspectSnapshotCompleteness(args: {
  blocks: AuditBlockLite[];
  items: SnapshotItem[];
  prior_open_issues: SuspectedOmission[];
  complete: JsonCompletion;
}): Promise<SnapshotCompletenessAssessment> {
  // As in the current audit owner, only empty text is excluded mechanically.
  // Titles and short fragments can still contain evidence; the model judges them.
  const scope = args.blocks.filter((block) => block.text.trim().length > 0);
  const allIds = scope.map((block) => block.id);
  const priorUnresolved = args.prior_open_issues.map((issue) => unresolved(issue.issue_id));
  const failed = (): SnapshotCompletenessAssessment => ({
    risk_level: "check_failed",
    checked_block_ids: [],
    unchecked_block_ids: allIds,
    suspected_omissions: [...args.prior_open_issues],
    prior_issue_resolutions: priorUnresolved,
  });

  if (scope.length === 0) {
    return {
      risk_level: args.prior_open_issues.length ? "important" : "not_applicable",
      checked_block_ids: [], unchecked_block_ids: [],
      suspected_omissions: [...args.prior_open_issues], prior_issue_resolutions: priorUnresolved,
    };
  }

  let parsed: z.infer<typeof responseSchema>;
  try {
    const response = await args.complete({
      purpose: "snapshot_completeness",
      maxTokens: 4000,
      system: "Compare every source block with all current snapshot items semantically. A citation to a block does not cover every distinct claim in that block. Return JSON with suspected_omissions and prior_issue_resolutions. For each omission, include item_kind, summary, source_ref with source_file_id and block_id, a verbatim evidence_quote, basis (explicit or inferred), reason, and suggested_action. Distinct missing items may share a quote; give each its own summary. Consider each prior issue explicitly: disposition requires issue_id, outcome, and reason; when resolved or partly_resolved, provide matched_item_ref. Include checked_block_ids for every block actually inspected. Do not invent evidence or include gold fields.",
      user: JSON.stringify({ blocks: scope, items: args.items, prior_open_issues: args.prior_open_issues }),
    });
    parsed = responseSchema.parse(JSON.parse(response.raw));
  } catch {
    return failed();
  }

  const bySourceBlock = new Map(scope.map((block) => [JSON.stringify([block.source_file_id, block.id]), block]));
  const checkedIds = parsed.checked_block_ids;
  if (new Set(checkedIds).size !== checkedIds.length || checkedIds.some((id) => !allIds.includes(id))) return failed();
  const checked = new Set(checkedIds);
  for (const finding of parsed.suspected_omissions) {
    const block = bySourceBlock.get(JSON.stringify([finding.source_ref.source_file_id, finding.source_ref.block_id]));
    if (!block || !checked.has(block.id) || !block.text.includes(finding.evidence_quote)) return failed();
  }

  const itemRefs = new Set(args.items.map((item) => item.item_ref));
  const rawDispositions = parsed.prior_issue_resolutions.flatMap((value) => {
    const candidate = dispositionSchema.safeParse(value);
    return candidate.success ? [candidate.data] : [];
  });
  const resolutions = args.prior_open_issues.map((issue): OmissionResolution => {
    const matches = rawDispositions.filter((entry) => entry.issue_id === issue.issue_id);
    if (matches.length !== 1) return unresolved(issue.issue_id);
    const entry = matches[0];
    if (entry.outcome === "unresolved") return { issue_id: issue.issue_id, outcome: "unresolved", reason: entry.reason };
    if (entry.matched_item_ref && !itemRefs.has(entry.matched_item_ref)) return unresolved(issue.issue_id);
    if ((entry.outcome === "resolved" || entry.outcome === "partly_resolved") && !entry.matched_item_ref) return unresolved(issue.issue_id);
    return { issue_id: issue.issue_id, outcome: entry.outcome, reason: entry.reason, ...(entry.matched_item_ref ? { matched_item_ref: entry.matched_item_ref } : {}) };
  });

  const activePrior = args.prior_open_issues.filter((issue, index) => {
    const outcome = resolutions[index].outcome;
    return outcome === "unresolved" || outcome === "partly_resolved";
  });
  const idsByFinding = new Map(args.prior_open_issues.map((issue) => [findingIdentity(issue), issue.issue_id]));
  const reservedIds = new Set(args.prior_open_issues.map((issue) => issue.issue_id));
  const closedIds = new Set(resolutions.filter((entry) => entry.outcome === "resolved" || entry.outcome === "invalid").map((entry) => entry.issue_id));
  const omissions = new Map(activePrior.map((issue) => [issue.issue_id, issue]));
  for (const finding of parsed.suspected_omissions) {
    const key = findingIdentity(finding);
    let issue_id = idsByFinding.get(key);
    if (!issue_id) {
      // Preserve the existing base ID, then allocate independent IDs for shared evidence.
      const baseId = `omission-${createHash("sha256").update(evidenceIdentity(finding)).digest("hex").slice(0, 16)}`;
      issue_id = baseId;
      let suffix = 2;
      while (reservedIds.has(issue_id)) issue_id = `${baseId}-${suffix++}`;
      reservedIds.add(issue_id);
    }
    idsByFinding.set(key, issue_id);
    if (closedIds.has(issue_id)) continue;
    if (omissions.has(issue_id)) continue;
    omissions.set(issue_id, {
      issue_id, item_kind: finding.item_kind, summary: finding.summary,
      source_ref: finding.source_ref, evidence_quote: finding.evidence_quote,
      basis: finding.basis, importance: finding.basis === "explicit" ? "important" : "advisory",
      reason: finding.reason, suggested_action: finding.suggested_action,
    });
  }
  const suspected_omissions = [...omissions.values()];
  const unchecked_block_ids = allIds.filter((id) => !checked.has(id));
  const risk_level = unchecked_block_ids.length || suspected_omissions.some((issue) => issue.importance === "important")
    ? "important" : suspected_omissions.length ? "advisory" : "none_detected";
  return { risk_level, checked_block_ids: checkedIds, unchecked_block_ids, suspected_omissions, prior_issue_resolutions: resolutions };
}
