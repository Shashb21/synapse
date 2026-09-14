import Link from "next/link";
import type { CanonicalInsight, ParsedDocument, Theme } from "@/lib/schema";
import { FUNCTION_LABELS } from "@/lib/schema";

export function AppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: "briefing" | "ingest" | "evals" | "sdlc";
}) {
  const links = [
    { href: "/", id: "briefing" as const, label: "MONITOR" },
    { href: "/ingest", id: "ingest" as const, label: "INGEST" },
    { href: "/evals", id: "evals" as const, label: "EVAL" },
    { href: "/sdlc", id: "sdlc" as const, label: "SPEC" },
  ];
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-[#07090d]">
        <div className="flex items-stretch">
          <div className="flex items-center border-r border-border px-3 py-2">
            <Link href="/" className="text-primary no-underline">
              <span className="text-[11px] tracking-[0.28em]">SYNAPSE</span>
            </Link>
          </div>
          <nav className="flex flex-1 flex-wrap">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`border-r border-border px-3 py-2 text-[11px] tracking-widest no-underline ${
                  active === l.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-3 py-3 sm:px-4">
        {children}
      </main>
      <footer className="border-t border-border px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground">
        SYNAPSE // THEME MONITOR // CIR LINKED NOT COPIED // LLAMACLOUD+CLAUDE
      </footer>
    </div>
  );
}

export function ClassTag({
  value,
}: {
  value: CanonicalInsight["classification"];
}) {
  const color =
    value === "known"
      ? "text-[var(--known)]"
      : value === "unknown"
        ? "text-[var(--unknown)]"
        : "text-[var(--opportunity)]";
  return (
    <span className={`text-[10px] font-semibold tracking-widest ${color}`}>
      {value === "opportunity" ? "OPP" : value.toUpperCase()}
    </span>
  );
}

export function InsightRow({
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
  const others = insight.theme_ids.filter((id) => id !== currentThemeId);
  const also = others
    .map((id) => themes.find((t) => t.id === id))
    .filter((t): t is Pick<Theme, "id" | "name"> => Boolean(t));

  return (
    <tr className="border-b border-border align-top hover:bg-muted/50">
      <td className="px-2 py-2">
        <ClassTag value={insight.classification} />
      </td>
      <td className="px-2 py-2 text-[12.5px] leading-5 text-foreground">
        {insight.statement}
        <div className="mt-1 text-[10px] text-muted-foreground">
          {FUNCTION_LABELS[insight.stakeholder_function]}
          {insight.knowledge_state.evidence_strength !== "single_source"
            ? ` · ${insight.knowledge_state.evidence_strength.replace("_", " ")}`
            : ""}
        </div>
      </td>
      <td className="px-2 py-2 text-[11px]">
        {source ? (
          <Link href={`/sources/${source.id}`} className="text-primary">
            {source.title}
          </Link>
        ) : (
          <span className="text-muted-foreground">Unknown source</span>
        )}
        <div className="text-[10px] text-muted-foreground">
          {insight.source_location.ref}
        </div>
      </td>
      <td className="px-2 py-2 text-[11px]">
        {also.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-1">
            {also.map((t) => (
              <Link key={t.id} href={`/themes/${t.id}`} className="text-primary">
                {t.name}
              </Link>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
