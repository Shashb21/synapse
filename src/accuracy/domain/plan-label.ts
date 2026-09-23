/**
 * Workspace plan_label: IEP (BGB-style integrated evidence plan) vs IEGP
 * (Tislelizumab-style integrated evidence generation plan). Stored in
 * `accuracy_workspaces.planning_context.plan_label`.
 */

export const PLAN_LABELS = ["IEP", "IEGP"] as const;
export type PlanLabel = (typeof PLAN_LABELS)[number];

export type PackPlanLabelSource = {
  id?: string;
  doc_type?: string | null;
};

export function isPlanLabel(value: unknown): value is PlanLabel {
  return value === "IEP" || value === "IEGP";
}

/** Normalize UI/API input to IEP | IEGP. */
export function normalizePlanLabel(value: unknown): PlanLabel | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper === "IEP") return "IEP";
  if (upper === "IEGP") return "IEGP";
  const slug = trimmed.toLowerCase().replace(/[^a-z]+/g, "_");
  if (slug === "integrated_evidence_plan" || slug === "iep") return "IEP";
  if (
    slug === "integrated_evidence_generation_plan" ||
    slug === "iegp" ||
    slug === "integrated_evidence_generation"
  ) {
    return "IEGP";
  }
  return null;
}

/** BGB pack is an IEP; Tisle pack is an IEGP. Default IEGP. */
export function planLabelFromPack(pack: PackPlanLabelSource | null | undefined): PlanLabel {
  if (!pack) return "IEGP";
  const fromType = normalizePlanLabel(pack.doc_type);
  if (fromType) return fromType;
  const id = pack.id?.toLowerCase() ?? "";
  if (id.includes("iegp")) return "IEGP";
  if (/\biep\b/.test(id) || id.includes("-iep") || id.endsWith("iep")) return "IEP";
  return "IEGP";
}

export function planLabelFromPlanningContext(context: unknown): PlanLabel | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  return normalizePlanLabel((context as { plan_label?: unknown }).plan_label);
}

export function workspacePlanLabel(workspace: {
  planning_context?: unknown;
} | null | undefined): PlanLabel | null {
  if (!workspace) return null;
  return planLabelFromPlanningContext(workspace.planning_context);
}

/** Merge plan_label into planning_context jsonb without dropping other keys. */
export function planningContextWithPlanLabel(
  existing: unknown,
  plan_label: PlanLabel | string | null | undefined,
): Record<string, unknown> | null {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (plan_label === undefined) {
    return Object.keys(base).length ? base : null;
  }
  const normalized = normalizePlanLabel(plan_label);
  if (normalized) base.plan_label = normalized;
  else delete base.plan_label;
  return Object.keys(base).length ? base : null;
}

/** Sidebar caption under Synapse · Accuracy. */
export function chromeStackCaption(planLabel: PlanLabel | null | undefined): string {
  if (planLabel === "IEP") return "Multi-tenant IEP stack";
  return "Multi-tenant IEGP stack";
}

/** Accessible chrome badge copy — tests and aria-label. */
export function chromePlanLabelStatus(planLabel: PlanLabel | null | undefined): string | null {
  if (!isPlanLabel(planLabel)) return null;
  return `Plan type ${planLabel}`;
}
