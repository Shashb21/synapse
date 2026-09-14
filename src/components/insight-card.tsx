import Link from "next/link";
import { FUNCTION_LABELS, type CanonicalInsight } from "@/lib/schema";
import { Badge } from "@/components/ui/badge";

const CLASS_STYLES = {
  known: "text-[var(--known)] bg-[color-mix(in_oklch,var(--known)_12%,white)]",
  unknown:
    "text-[var(--unknown)] bg-[color-mix(in_oklch,var(--unknown)_14%,white)]",
  opportunity:
    "text-[var(--opportunity)] bg-[color-mix(in_oklch,var(--opportunity)_14%,white)]",
};

export function InsightCard({
  insight,
  themeNames,
}: {
  insight: CanonicalInsight;
  themeNames?: string[];
}) {
  const multi = insight.knowledge_state.evidence_strength !== "single_source";
  return (
    <article className="rounded-lg border border-border/80 bg-card p-3.5 shadow-[0_1px_0_oklch(0.3_0.02_250/0.04)]">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${CLASS_STYLES[insight.classification]}`}
        >
          {insight.classification}
        </span>
        <Badge variant="outline" className="font-normal">
          {FUNCTION_LABELS[insight.stakeholder_function]}
        </Badge>
        {(themeNames ?? []).map((name) => (
          <Badge key={name} variant="secondary" className="font-normal">
            {name}
          </Badge>
        ))}
        {multi ? (
          <Badge variant="outline" className="font-normal">
            {insight.knowledge_state.evidence_strength.replace("_", " ")}
          </Badge>
        ) : null}
      </div>
      <p className="text-[13.5px] leading-5 text-foreground">{insight.statement}</p>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        <span className="font-medium text-foreground/70">
          {insight.source_location.ref}
        </span>
        {" · "}
        <span className="italic">“{insight.evidence_quote.slice(0, 140)}
        {insight.evidence_quote.length > 140 ? "…" : ""}”</span>
      </p>
    </article>
  );
}

export function AppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: "briefing" | "ingest" | "evals" | "sdlc";
}) {
  const links = [
    { href: "/", id: "briefing" as const, label: "Briefing" },
    { href: "/ingest", id: "ingest" as const, label: "Ingest" },
    { href: "/evals", id: "evals" as const, label: "Eval lab" },
    { href: "/sdlc", id: "sdlc" as const, label: "SDLC" },
  ];
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border/80 bg-card/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <div>
            <p className="text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
              Real-time insights engine
            </p>
            <h1 className="font-heading text-3xl tracking-tight text-primary italic sm:text-[2rem]">
              Velmara
            </h1>
            <p className="text-sm text-muted-foreground">
              Cross-functional intelligence for 2L EGFRm NSCLC
            </p>
          </div>
          <nav className="flex flex-wrap gap-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  active === l.id
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/70 hover:bg-muted"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="border-t border-border/70 px-4 py-4 text-center text-[11px] text-muted-foreground sm:px-6">
        CIR JSONL · critique / judge / proposer hill-climb · local parsers with
        optional LlamaParse
      </footer>
    </div>
  );
}
