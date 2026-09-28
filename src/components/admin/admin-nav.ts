/** The owner console's sections, in nav order. Every lab surface lives under /admin. */
export type AdminSectionId =
  | "overview"
  | "control"
  | "users"
  | "accuracy"
  | "pipeline"
  | "runs"
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
    summary: "The AI on/off switch, provider logins and per-stage model routing.",
  },
  {
    id: "users",
    href: "/admin/users",
    label: "Users",
    summary: "Email and password accounts: create, reset passwords, roles, verify, disable, unlock.",
  },
  {
    id: "accuracy",
    href: "/admin/accuracy",
    label: "Accuracy",
    summary: "The accuracy lab: workspaces, sources, review, ledger, coverage, plan, timeline, audit, routing, runs.",
  },
  { id: "pipeline", href: "/admin/pipeline", label: "Pipeline", summary: "Run any stage S0–S10, or the chain, and its evals." },
  { id: "runs", href: "/admin/runs", label: "Runs & traces", summary: "Every stage run: inputs, outputs, route, timing, scores." },
  { id: "evals", href: "/admin/evals", label: "Evals", summary: "Gold recall and coverage scores for the committed plan." },
  { id: "catalog", href: "/admin/catalog", label: "Catalog", summary: "Every registered module and prompt variant." },
  { id: "modules", href: "/admin/modules", label: "Module versions", summary: "Which module version each stage runs." },
  { id: "sdlc", href: "/admin/sdlc", label: "SDLC", summary: "Requirements, architecture, design and process specs." },
  { id: "docs", href: "/admin/docs", label: "Docs", summary: "The raw spec documents." },
];

/** The section a pathname belongs to (longest matching prefix). */
export function adminSectionFor(pathname: string): AdminSectionId {
  const match = ADMIN_SECTIONS.filter(
    (section) => pathname === section.href || (section.href !== "/admin" && pathname.startsWith(`${section.href}/`)),
  ).sort((a, b) => b.href.length - a.href.length)[0];
  return match?.id ?? "overview";
}
