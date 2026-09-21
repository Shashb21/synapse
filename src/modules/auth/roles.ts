import type { ActorFunction } from "@/lib/iegp/enums";

/**
 * Roles are coarse: what someone may do to the plan. Their function (Medical
 * Affairs, HEOR, …) stays on every record for provenance. Medical Affairs is the
 * primary role.
 */
export const ROLES = ["medical_affairs", "contributor", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  medical_affairs: "Medical Affairs",
  contributor: "Contributing function",
  operator: "Platform operator",
  viewer: "Viewer",
};

export const ROLE_SUMMARIES: Record<Role, string> = {
  medical_affairs: "Owns the plan: ingest, validate, prioritize, ideate, save the IEGP as final.",
  contributor: "Other functions: ingest, propose, comment and edit with rationale; cannot save final.",
  operator: "Platform: routing, provider connections, module versions, plus everything a lead can do.",
  viewer: "Read-only across the plan. Can still route their own API calls in the control panel.",
};

export const CAPABILITIES = [
  "upload",
  "run_stage",
  "validate",
  "prioritize",
  "ideate",
  "save_final",
  "export",
  "configure_routing",
  "connect_provider",
  "activate_module",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Control-panel routing is available to all roles by product decision. */
const MATRIX: Record<Role, Capability[]> = {
  medical_affairs: [
    "upload",
    "run_stage",
    "validate",
    "prioritize",
    "ideate",
    "save_final",
    "export",
    "configure_routing",
    "connect_provider",
  ],
  contributor: ["upload", "run_stage", "validate", "prioritize", "ideate", "export", "configure_routing"],
  operator: [...CAPABILITIES],
  viewer: ["export", "configure_routing"],
};

export function can(role: Role, capability: Capability): boolean {
  return MATRIX[role].includes(capability);
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...MATRIX[role]];
}

export function isRole(value: string | undefined | null): value is Role {
  return ROLES.includes((value ?? "") as Role);
}

/** Default role for a function when an identity provider gives no role claim. */
export function roleForFunction(fn: ActorFunction): Role {
  return fn === "medical_affairs" || fn === "evidence_lead" ? "medical_affairs" : "contributor";
}

export class ForbiddenError extends Error {
  constructor(role: Role, capability: Capability) {
    super(`${ROLE_LABELS[role]} may not ${capability.replace(/_/g, " ")}.`);
  }
}

export function assertCan(role: Role, capability: Capability) {
  if (!can(role, capability)) throw new ForbiddenError(role, capability);
}
