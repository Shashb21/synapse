import Link from "next/link";
import type { CanonicalInsight, ParsedDocument, Theme } from "@/lib/schema";
import { FUNCTION_LABELS } from "@/lib/schema";
import { themeStyle } from "@/lib/theme-style";
import { ClassChip, ThemeChip } from "@/components/theme-chip";

export function AppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: "briefing" | "insights" | "ingest" | "evals" | "sdlc";
}) {
  const links = [
    { href: "/", id: "briefing" as const, label: "Monitor" },
    { href: "/insights", id: "insights" as const, label: "Insights" },
    { href: "/ingest", id: "ingest" as const, label: "Ingest" },
    { href: "/evals", id: "evals" as const, label: "Eval" },
    { href: "/sdlc", id: "sdlc" as const, label: "Spec" },
  ];
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col items-start gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Link href="/" className="no-underline">
            <span className="text-lg font-semibold tracking-[0.18em] text-primary">
              SYNAPSE
            </span>
          </Link>
          <nav className="flex max-w-full flex-nowrap gap-1 overflow-x-auto rounded-full bg-muted/80 p-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap no-underline transition ${
                  active === l.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background hover:text-foreground"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-5 py-8 sm:px-8 sm:py-10">
        {children}
      </main>
      <footer className="border-t border-border/70 px-5 py-4 text-center text-xs text-muted-foreground sm:px-8">
        Themes first · insights linked, not copied · LlamaCloud + Claude
      </footer>
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
    <div className="mb-8">
      {kicker ? (
        <p className="mb-2 text-xs font-medium tracking-[0.16em] text-primary uppercase">
          {kicker}
        </p>
      ) : null}
      <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {title}
      </h1>
      {children ? (
        <div className="mt-3 max-w-3xl text-base leading-7 text-muted-foreground">
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
  const accent = themeStyle(linked[0]?.id ?? currentThemeId ?? "THEME-RESIDUAL");

  return (
    <article
      className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6"
      style={{
        borderColor: accent.border,
        boxShadow: `0 12px 32px -18px ${accent.glow}`,
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
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
      <p className="mt-4 text-[15px] leading-7 text-foreground sm:text-base">
        {insight.statement}
      </p>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        {source ? (
          <Link href={`/sources/${source.id}`} className="text-primary no-underline hover:underline">
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
