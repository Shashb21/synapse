/** Conservative structural finding lifecycle; positional issue IDs are observation labels only. */
import { createHash } from "node:crypto";
import { structuralResolutionSchema, type CriticIssue, type StructuralIssueResolution } from "./agent-events";

export type OpenStructuralIssue = { issue: CriticIssue; check_id: string | null; feedback: boolean };
export type StructuralCheck = { id: string; exhaustive: true };

/** Evidence identity excludes transient row positions and canonicalizes object key order. */
export function structuralContentFingerprint(value: unknown): string {
  const canonical = (node: unknown): unknown => Array.isArray(node) ? node.map(canonical)
    : node !== null && typeof node === "object" ? Object.fromEntries(Object.entries(node)
      .filter(([key]) => key !== "candidate_index").sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)])) : node;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function structuralIssueKey(issue: CriticIssue): string {
  return createHash("sha256").update(JSON.stringify([issue.category, issue.code, issue.claim,
    issue.source_ref?.source_file_id ?? null, issue.source_ref?.block_id ?? null, issue.content_fingerprint ?? null])).digest("hex");
}

/** Each prior open issue gets exactly one explained fate, even if the critic fails. */
export async function assessStructuralFate(args: {
  prior: OpenStructuralIssue[];
  current: CriticIssue[];
  check?: StructuralCheck;
  failed: boolean;
  dispositions?: unknown[];
  feedback_keys?: Set<string>;
  validate?: (resolution: StructuralIssueResolution) => Promise<boolean>;
}): Promise<{ resolutions: StructuralIssueResolution[]; open: OpenStructuralIssue[] }> {
  const current = new Map(args.current.map(issue => [structuralIssueKey(issue), issue]));
  const resolutions: StructuralIssueResolution[] = [];
  const open: OpenStructuralIssue[] = [];
  for (const prior of args.prior) {
    const issue_key = structuralIssueKey(prior.issue);
    let resolution: StructuralIssueResolution = { issue_key, issue: prior.issue, outcome: "unresolved",
      reason: args.failed ? "Structural assessment failed; prior finding remains open."
        : "No validated disposition was supplied; prior finding remains open.", evidence: null };
    const supplied = (Array.isArray(args.dispositions) ? args.dispositions : []).filter(value =>
      value !== null && typeof value === "object" && "issue_key" in value && value.issue_key === issue_key);
    if (!args.failed && supplied.length === 1) {
      const parsed = structuralResolutionSchema.safeParse(supplied[0]);
      if (parsed.success && structuralIssueKey(parsed.data.issue) === issue_key
        && parsed.data.evidence?.kind === "validated_assessment" && args.validate) {
        try { if (await args.validate(parsed.data)) resolution = { ...parsed.data, issue: prior.issue }; }
        catch { /* Failed evidence validation cannot close a finding. */ }
      }
    } else if (!args.failed && args.dispositions === undefined && supplied.length === 0 && args.check?.exhaustive
      && prior.check_id === args.check.id && !current.has(issue_key)) {
      resolution = { issue_key, issue: prior.issue, outcome: "resolved",
        reason: `Exhaustive deterministic check ${args.check.id} reran successfully; this content/evidence finding is absent.`,
        evidence: { kind: "deterministic_rerun", check_id: args.check.id } };
    }
    // A still-observed finding contradicts a claimed closure.
    if (current.has(issue_key) && ["resolved", "invalid"].includes(resolution.outcome)) {
      resolution = { issue_key, issue: prior.issue, outcome: "unresolved",
        reason: "The finding is still present in the current assessment; claimed closure was rejected.", evidence: null };
    }
    resolutions.push(resolution);
    if (["unresolved", "partly_resolved"].includes(resolution.outcome)) {
      open.push({ ...prior, issue: current.get(issue_key) ?? prior.issue });
    }
  }
  const retained = new Set(open.map(row => structuralIssueKey(row.issue)));
  for (const [key, issue] of current) {
    if (!retained.has(key)) open.push({ issue, check_id: args.check?.id ?? null, feedback: args.feedback_keys?.has(key) ?? true });
  }
  return { resolutions, open };
}
