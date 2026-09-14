import Link from "next/link";
import type { CanonicalInsight, ParsedDocument, Theme } from "@/lib/schema";
import { FUNCTION_LABELS } from "@/lib/schema";
import { ClassChip, ThemeChip } from "@/components/theme-chip";

export function AppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: "briefing" | "insights" | "catalog" | "graph" | "ingest" | "evals" | "sdlc";
}) {
  const links = [
    { href: "/", id: "briefing" as const, label: "Monitor" },
    { href: "/insights", id: "insights" as const, label: "Insights" },
    { href: "/catalog", id: "catalog" as const, label: "Catalog" },
    { href: "/graph", id: "graph" as const, label: "Graph" },
    { href: "/ingest", id: "ingest" as const, label: "Ingest" },
    { href: "/evals", id: "evals" as const, label: "Eval" },
    { href: "/sdlc", id: "sdlc" as const, label: "Spec" },
  ];
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-[1100px] items-center gap-6 px-4 py-2.5 sm:px-6">
          <Link href="/" className="text-[13px] font-medium text-foreground no-underline">
            Synapse
          </Link>
          <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[13px] no-underline ${
                  active === l.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export function PageIntro({
  kicker,
  title,
  children,
}: {
  kicker?: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      {kicker ? (
        <p className="mb-1 text-[11px] text-muted-foreground">{kicker}</p>
      ) : null}
      <h1 className="text-lg font-medium text-foreground">{title}</h1>
      {children ? (
        <div className="mt-2 max-w-3xl text-[13px] leading-5 text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function InsightCard({
  insight,
  currentThemeId,
  themes,
  documents,
}: {
  insight: CanonicalInsight;
  currentThemeId?: string;
  themes: Pick<Theme, "id" | "name">[];
  documents: Pick<ParsedDocument, "id" | "title" | "filename">[];
}) {
  const source = documents.find((d) => d.id === insight.source_document_id);
  const linked = insight.theme_ids
    .map((id) => themes.find((t) => t.id === id))
    .filter((t): t is Pick<Theme, "id" | "name"> => Boolean(t));

  return (
    <article className="border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <ClassChip value={insight.classification} />
        {linked.map((t) => (
          <ThemeChip
            key={t.id}
            id={t.id}
            name={t.name}
            href={`/themes/${t.id}`}
            current={t.id === currentThemeId}
          />
        ))}
      </div>
      <p className="mt-3 text-[13px] leading-5 text-foreground">
        {insight.statement}
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {source ? (
          <Link
            href={`/sources/${source.id}`}
            className="text-muted-foreground no-underline hover:text-foreground hover:underline"
          >
            {source.title}
          </Link>
        ) : (
          <span>Unknown source</span>
        )}
        <span>{insight.source_location.ref}</span>
        <span>{FUNCTION_LABELS[insight.stakeholder_function]}</span>
        {insight.knowledge_state.evidence_strength !== "single_source" ? (
          <span className="capitalize">
            {insight.knowledge_state.evidence_strength.replace("_", " ")}
          </span>
        ) : null}
      </div>
    </article>
  );
}
