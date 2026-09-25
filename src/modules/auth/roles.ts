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
  /** The admin AI switch: turn every AI suggestion and automatic AI action on or off. */
  "toggle_ai",
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
    "toggle_ai",
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

/**
 * The owner runs the platform: the admin console (/admin), the accuracy lab,
 * routing, provider logins, the AI switch and module versions. Customers never
 * see any of it.
 */
export type OwnerSubject = {
  role: Role;
  email: string | null;
  signed_in: boolean;
  /** No identity provider configured: the typed-name demo stands in. */
  demo: boolean;
  /** "demo" for a demo sign-in, else the identity provider id; null when unsigned. */
  provider_id: string | null;
};

/** Emails listed in OWNER_EMAILS (comma-separated), normalised to lower case. */
export function ownerEmails(raw: string | undefined = process.env.OWNER_EMAILS): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Test-only: under the Playwright/Vitest LLM stub (never in production) the
 * demo session acts as the owner so the lab surfaces stay testable.
 */
export function testOwnerBypass(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.SYNAPSE_TEST_STUB_LLM === "1";
}

export type OwnerDecision = { owner: boolean; reason: string };

export type OwnerOptions = {
  emails?: string[];
  /** Defaults to testOwnerBypass(). */
  bypass?: boolean;
  /** A test asked to be treated as a customer (only meaningful under the bypass). */
  optOut?: boolean;
};

/**
 * Owner = role "operator", or a signed-in email listed in OWNER_EMAILS. The
 * test bypass covers only the demo session (unsigned demo, or a demo sign-in).
 */
export function ownerDecision(subject: OwnerSubject, options: OwnerOptions = {}): OwnerDecision {
  if (subject.role === "operator") return { owner: true, reason: "operator role" };
  const emails = options.emails ?? ownerEmails();
  const email = subject.email?.trim().toLowerCase();
  if (subject.signed_in && email && emails.includes(email)) {
    return { owner: true, reason: "listed in OWNER_EMAILS" };
  }
  const bypass = options.bypass ?? testOwnerBypass();
  const demoSession = subject.demo && (!subject.signed_in || subject.provider_id === "demo");
  if (bypass && demoSession && !options.optOut) {
    return { owner: true, reason: "test stub demo session" };
  }
  return { owner: false, reason: "not the owner" };
}

export function isOwner(subject: OwnerSubject, options?: OwnerOptions): boolean {
  return ownerDecision(subject, options).owner;
}

export const OWNER_ONLY_MESSAGE = "Owner only. This is the platform owner's control panel.";
