import { AppShell, InsightCard } from "@/components/insight-card";
import { getState } from "@/lib/store";
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
  const insights = state.insights.filter((i) => i.theme_ids.includes(id));
  const links = state.theme_links.filter((l) => l.theme_id === id);

  return (
    <AppShell active="briefing">
      <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
        Theme · {insights.length} linked insights · not duplicated
      </p>
      <h2 className="font-heading text-3xl text-primary">{theme.name}</h2>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        {theme.summary}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        {theme.known_count} known · {theme.unknown_count} unknown ·{" "}
        {theme.opportunity_count} opportunities
      </p>
      <div className="mt-6 grid gap-2.5 md:grid-cols-2">
        {insights.map((insight) => {
          const link = links.find((l) => l.insight_id === insight.id);
          const names = insight.theme_ids
            .map((tid) => state.themes.find((t) => t.id === tid)?.name)
            .filter((n): n is string => Boolean(n));
          return (
            <div key={insight.id} className="space-y-1">
              {link ? (
                <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                  {link.role} · {link.method} · score {link.score.toFixed(2)}
                </p>
              ) : null}
              <InsightCard insight={insight} themeNames={names} />
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
