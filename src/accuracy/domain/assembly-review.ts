/** Pure approval policy for exact immutable extraction assemblies. */
import { createHash } from "node:crypto";
import type { Role } from "@/modules/auth/roles";
import type { Actor } from "@/accuracy/kernel/contracts";
import type { AssemblyCheckReport } from "./assembly";
export { assemblyExecutionScope, withAssemblyExperiment, withAssemblyPreparation } from "@/accuracy/kernel/assembly-context";

export type AssemblyReviewDecision = "approve" | "reject";
export type AssemblyReviewErrorCode = "invalid_input" | "not_found" | "conflict" | "forbidden" | "approval_required";

export class AssemblyReviewError extends Error {
  constructor(readonly code: AssemblyReviewErrorCode, message: string) {
    super(message);
    this.name = "AssemblyReviewError";
  }
}

export type AssemblyReviewer = {
  subject: string;
  provider: string;
  actor: Actor;
  role: Role;
};

export type AssemblyReviewOverride = {
  code: string;
  item_version_ids: string[];
  reason: string;
};

export type AssemblyReview = {
  id: string;
  workspace_id: string;
  assembly_id: string;
  fingerprint: string;
  checks_fingerprint: string;
  decision: AssemblyReviewDecision;
  rationale: string;
  advisory_overrides: AssemblyReviewOverride[];
  reviewer_subject: string;
  reviewer_provider: string;
  reviewer_actor_name: string;
  reviewer_actor_function: string;
  reviewer_role: Role;
  created_at: string;
};

export type AssemblyReviewPolicyResult = Omit<AssemblyReview,
  "id" | "workspace_id" | "assembly_id" | "fingerprint" | "checks_fingerprint" | "created_at"> & {
  advisory_overrides: AssemblyReviewOverride[];
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function findingKey(value: { code: string; item_version_ids: string[] }): string {
  return canonicalString({ code: value.code, item_version_ids: value.item_version_ids });
}

function requireText(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new AssemblyReviewError("invalid_input", `${label} is required.`);
  return trimmed;
}

function requireReviewer(reviewer: AssemblyReviewer) {
  requireText(reviewer.subject, "Reviewer subject");
  requireText(reviewer.provider, "Reviewer provider");
  requireText(reviewer.actor?.name, "Reviewer name");
  requireText(reviewer.actor?.function, "Reviewer function");
  if (reviewer.role !== "contributor" && reviewer.role !== "medical_affairs") {
    throw new AssemblyReviewError("forbidden", "Only contributors and Medical Affairs reviewers can decide an assembly.");
  }
}

/** Fingerprint the full persisted check report, including checker version, severity, identity and messages. */
export function assemblyCheckFingerprint(checks: AssemblyCheckReport): string {
  return createHash("sha256").update(canonicalString(checks)).digest("hex");
}

/** Validate and normalize a human approval/rejection request against current assembly checks. */
export function evaluateAssemblyReviewRequest(args: {
  decision: AssemblyReviewDecision;
  rationale: string;
  advisory_overrides?: AssemblyReviewOverride[];
  reviewer: AssemblyReviewer;
  checks: AssemblyCheckReport;
}): AssemblyReviewPolicyResult {
  if (args.decision !== "approve" && args.decision !== "reject") {
    throw new AssemblyReviewError("invalid_input", "Review decision must be approve or reject.");
  }
  requireReviewer(args.reviewer);
  const rationale = requireText(args.rationale, "Review rationale");
  const overrides = args.advisory_overrides ?? [];
  const blocking = args.checks.findings.filter((finding) => finding.severity === "blocking");
  const advisories = args.checks.findings.filter((finding) => finding.severity === "advisory");
  const advisoryKeys = new Set(advisories.map(findingKey));
  const seen = new Set<string>();
  const normalizedOverrides = overrides.map((override) => {
    if (!override || typeof override.code !== "string" || !Array.isArray(override.item_version_ids)) {
      throw new AssemblyReviewError("invalid_input", "Advisory overrides must identify a finding code and item versions.");
    }
    const normalized = { code: override.code, item_version_ids: override.item_version_ids, reason: requireText(override.reason, "Advisory override reason") };
    const key = findingKey(normalized);
    if (seen.has(key)) throw new AssemblyReviewError("invalid_input", "Advisory override is duplicated.");
    seen.add(key);
    if (!advisoryKeys.has(key)) {
      throw new AssemblyReviewError("invalid_input", "Advisory override does not match a current advisory finding.");
    }
    return normalized;
  });

  if (args.decision === "approve") {
    if (args.checks.status !== "passed" || blocking.length > 0) {
      throw new AssemblyReviewError("approval_required", "Blocking assembly findings cannot be approved.");
    }
    const missing = advisories.filter((finding) => !seen.has(findingKey(finding)));
    if (missing.length > 0) {
      throw new AssemblyReviewError("invalid_input", "Every advisory finding requires an explicit override reason before approval.");
    }
  }

  return {
    decision: args.decision,
    rationale,
    advisory_overrides: normalizedOverrides,
    reviewer_subject: args.reviewer.subject.trim(),
    reviewer_provider: args.reviewer.provider.trim(),
    reviewer_actor_name: args.reviewer.actor.name.trim(),
    reviewer_actor_function: args.reviewer.actor.function,
    reviewer_role: args.reviewer.role,
  };
}

/** Compare retry bodies without depending on object key order. */
export function sameReviewRequest(a: Pick<AssemblyReview, "decision" | "rationale" | "advisory_overrides" | "reviewer_subject" | "reviewer_provider" | "reviewer_actor_name" | "reviewer_actor_function" | "reviewer_role" | "fingerprint" | "checks_fingerprint">,
  b: Pick<AssemblyReview, "decision" | "rationale" | "advisory_overrides" | "reviewer_subject" | "reviewer_provider" | "reviewer_actor_name" | "reviewer_actor_function" | "reviewer_role" | "fingerprint" | "checks_fingerprint">): boolean {
  const comparable = (value: typeof a) => ({
    decision: value.decision,
    rationale: value.rationale,
    advisory_overrides: value.advisory_overrides,
    reviewer_subject: value.reviewer_subject,
    reviewer_provider: value.reviewer_provider,
    reviewer_actor_name: value.reviewer_actor_name,
    reviewer_actor_function: value.reviewer_actor_function,
    reviewer_role: value.reviewer_role,
    fingerprint: value.fingerprint,
    checks_fingerprint: value.checks_fingerprint,
  });
  return canonicalString(comparable(a)) === canonicalString(comparable(b));
}
