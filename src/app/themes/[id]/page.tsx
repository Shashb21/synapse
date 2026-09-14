import { AppShell, InsightRow } from "@/components/insight-card";
import { summarizeTheme } from "@/lib/briefing/theme-summary";
import { getState } from "@/lib/store";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ThemePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await getState();
  const theme = state.themes.find((t) => t.id === id);
  if (!theme) notFound();
  const insights = state.insights
    .filter((i) => i.theme_ids.includes(id))
    .sort((a, b) => {
      const order = { unknown: 0, opportunity: 1, known: 2 };
      return order[a.classification] - order[b.classification];
    });
  const brief = summarizeTheme(theme, state.insights, state.asset.as_of);
  const docs = state.documents.map((d) => ({
    id: d.id,
    title: d.title,
    filename: d.filename,
  }));

  return (
    <AppShell active="briefing">
      <p className="text-[10px] tracking-widest text-muted-foreground">
        <Link href="/" className="text-muted-foreground">
          MONITOR
        </Link>
        {" / "}
        {theme.name.toUpperCase()}
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2 border-b border-border pb-2">
        <h1 className="text-sm tracking-[0.2em] text-primary">
          {theme.name.toUpperCase()}
        </h1>
        <p className="text-[10px] text-muted-foreground">
          AS OF {brief.as_of_label} · {brief.posture} · {insights.length} INS
        </p>
      </div>
      <p className="mt-3 max-w-4xl text-[13px] leading-5">{brief.situation}</p>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {theme.known_count} known · {theme.unknown_count} unknown ·{" "}
        {theme.opportunity_count} opportunities. Same CIR may also sit on other
        themes — linked, not copied.
      </p>

      {insights.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No insights linked.</p>
      ) : (
        <div className="mt-4 overflow-x-auto border border-border">
          <table className="w-full min-w-[860px] text-left">
            <thead className="border-b border-border bg-muted/40 text-[10px] tracking-widest text-muted-foreground">
              <tr>
                <th className="px-2 py-2">CLS</th>
                <th className="px-2 py-2">INSIGHT</th>
                <th className="px-2 py-2">SOURCE</th>
                <th className="px-2 py-2">ALSO IN</th>
              </tr>
            </thead>
            <tbody>
              {insights.map((insight) => (
                <InsightRow
                  key={insight.id}
                  insight={insight}
                  currentThemeId={id}
                  themes={state.themes}
                  documents={docs}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
