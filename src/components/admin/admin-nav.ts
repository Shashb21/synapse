/** The owner console's sections, in nav order. Every lab surface lives under /admin. */
export type AdminSectionId =
  | "overview"
  | "control"
  | "customers"
  | "users"
  | "accuracy"
  | "harness"
  | "pipeline"
  | "runs"
  | "learning"
  | "evals"
  | "catalog"
  | "modules"
  | "sdlc"
  | "docs";

export type AdminSection = { id: AdminSectionId; href: string; label: string; summary: string };

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: "overview", href: "/admin", label: "Overview", summary: "Where everything in the owner console lives." },
  {
    id: "control",
    href: "/admin/control",
    label: "AI & routing",
    summary: "The AI on/off switches, provider API key status (keys are set in the environment) and per-stage model routing.",
  },
  {
    id: "customers",
    href: "/admin/customers",
    label: "Customers",
    summary: "Customers, the seats they bought, and who holds them. Only seat holders can sign in with SSO.",
  },
  {
    id: "users",
    href: "/admin/users",
    label: "Users",
    summary: "Your staff's email and password accounts: create, reset passwords, roles, verify, disable, unlock.",
  },
  {
    id: "accuracy",
    href: "/admin/accuracy",
    label: "Accuracy",
    summary: "The accuracy lab: workspaces, sources, review, ledger, coverage, plan, timeline, audit, routing, runs.",
  },
  {
    id: "harness",
    href: "/admin/harness",
    label: "AI harness",
    summary: "Run each AI use case on its own against the live model, on samples or your own input.",
  },
  { id: "pipeline", href: "/admin/pipeline", label: "Pipeline", summary: "Run any stage S0–S10, or the chain, and its evals." },
  { id: "runs", href: "/admin/runs", label: "Runs & traces", summary: "Every stage run: inputs, outputs, route, timing, scores." },
  { id: "learning", href: "/admin/learning", label: "Decision learning", summary: "Reviewer agreement and immutable prompt candidates from validated lessons." },
  { id: "evals", href: "/admin/evals", label: "Evals", summary: "Gold recall and coverage scores for the committed plan." },
  { id: "catalog", href: "/admin/catalog", label: "Catalog", summary: "Every registered module and prompt variant." },
  { id: "modules", href: "/admin/modules", label: "Module versions", summary: "Which module version each stage runs." },
  { id: "sdlc", href: "/admin/sdlc", label: "SDLC", summary: "Requirements, architecture, design and process specs." },
  { id: "docs", href: "/admin/docs", label: "Docs", summary: "The raw spec documents." },
];

/** Where the owner picks the console's workspace (KAN-62). */
export const ADMIN_WORKSPACE_PICKER = "/admin/workspace";

/** The console's workspace picker, returning to `path` once a workspace is chosen. */
export function adminWorkspacePickerHref(path: string | null | undefined): string {
  const back = path && path !== "/admin" && !path.startsWith(ADMIN_WORKSPACE_PICKER) ? path : null;
  return back ? `${ADMIN_WORKSPACE_PICKER}?next=${encodeURIComponent(back)}` : ADMIN_WORKSPACE_PICKER;
}

/**
 * A run's trace page. Runs live in their workspace's schema, so the link names
 * the workspace and the page opens it there, whichever one the console is in.
 */
export function runTraceHref(runId: string, workspaceId: string | null | undefined): string {
  const path = `/admin/runs/${encodeURIComponent(runId)}`;
  return workspaceId ? `${path}?workspace=${encodeURIComponent(workspaceId)}` : path;
}

/** The section a pathname belongs to (longest matching prefix). */
export function adminSectionFor(pathname: string): AdminSectionId {
  const match = ADMIN_SECTIONS.filter(
    (section) => pathname === section.href || (section.href !== "/admin" && pathname.startsWith(`${section.href}/`)),
  ).sort((a, b) => b.href.length - a.href.length)[0];
  return match?.id ?? "overview";
}
