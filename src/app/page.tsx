import { AppShell, InsightCard } from "@/components/insight-card";
import { FUNCTION_LABELS } from "@/lib/schema";
import { dashboardView, getState } from "@/lib/store";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function BriefingPage() {
  const state = await getState();
  const view = dashboardView(state);
  const themeNames = (ids: string[]) =>
    ids
      .map((id) => view.themes.find((t) => t.id === id)?.name)
      .filter((n): n is string => Boolean(n));

  return (
    <AppShell active="briefing">
      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
        {[
          ["Sources", view.kpis.documents],
          ["Insights", view.kpis.insights],
          ["Themes", view.kpis.themes],
          ["Known", view.kpis.known],
          ["Unknown", view.kpis.unknown],
          ["Opportunities", view.kpis.opportunities],
          ["Multi-theme", view.kpis.multi_theme],
          ["Champion Fβ", view.kpis.champion_composite.toFixed(3)],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="rounded-lg border border-border/80 bg-card px-3 py-3"
          >
            <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
              {label}
            </p>
            <p className="font-heading text-2xl text-primary">{value}</p>
          </div>
        ))}
      </section>

      <p className="mb-5 text-sm text-muted-foreground">
        Champion extractor{" "}
        <span className="font-medium text-foreground">
          {view.champion_prompt_version}
        </span>
        {" · "}
        {view.asset.molecule} · {view.asset.indication} · as of {view.asset.as_of}
      </p>

      <section className="grid gap-4 lg:grid-cols-3">
        <Pane
          title="What we know"
          hint="Supported facts, triangulated across functions"
          tone="known"
          empty="No known insights yet. Ingest a readout."
        >
          {view.known.map((i) => (
            <InsightCard
              key={i.id}
              insight={i}
              themeNames={themeNames(i.theme_ids)}
            />
          ))}
        </Pane>
        <Pane
          title="What we don’t know"
          hint="Explicit gaps, unmeasured quantities, unanswered questions"
          tone="unknown"
          empty="No open gaps extracted. That’s usually a miss, not a win."
        >
          {view.unknown.map((i) => (
            <InsightCard
              key={i.id}
              insight={i}
              themeNames={themeNames(i.theme_ids)}
            />
          ))}
        </Pane>
        <Pane
          title="Opportunities to close gaps"
          hint="Concrete actions that would resolve an unknown"
          tone="opportunity"
          empty="No closure plays identified."
        >
          {view.opportunities.map((i) => (
            <InsightCard
              key={i.id}
              insight={i}
              themeNames={themeNames(i.theme_ids)}
            />
          ))}
        </Pane>
      </section>

      <section className="mt-10">
        <h2 className="font-heading text-2xl text-primary">Themes</h2>
        <p className="mb-4 text-sm text-muted-foreground">
        Same insight, many themes — linked, not copied. A formulary delay
        pending RWE shows up under Access and Evidence without duplicating the
        CIR.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {view.themes.map((theme) => {
            const total =
              theme.known_count +
              theme.unknown_count +
              theme.opportunity_count;
            const pct = (n: number) =>
              total === 0 ? 0 : Math.round((n / total) * 100);
            return (
              <Link
                key={theme.id}
                href={`/themes/${theme.id}`}
                className="rounded-xl border border-border/80 bg-card p-4 transition hover:border-primary/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-heading text-lg text-primary">
                      {theme.name}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {theme.summary}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {theme.insight_ids.length}
                  </span>
                </div>
                <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="bg-[var(--known)]"
                    style={{ width: `${pct(theme.known_count)}%` }}
                  />
                  <span
                    className="bg-[var(--unknown)]"
                    style={{ width: `${pct(theme.unknown_count)}%` }}
                  />
                  <span
                    className="bg-[var(--opportunity)]"
                    style={{ width: `${pct(theme.opportunity_count)}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {theme.known_count} known · {theme.unknown_count} unknown ·{" "}
                  {theme.opportunity_count} opportunities
                </p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-heading text-2xl text-primary">Coverage by function</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {view.coverageByFunction.map((row) => (
            <div
              key={row.function}
              className="rounded-lg border border-border/80 bg-card px-3 py-3"
            >
              <p className="text-sm font-medium">
                {FUNCTION_LABELS[row.function]}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.documents} source{row.documents === 1 ? "" : "s"} ·{" "}
                {row.insights} insights
              </p>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}

function Pane({
  title,
  hint,
  tone,
  empty,
  children,
}: {
  title: string;
  hint: string;
  tone: "known" | "unknown" | "opportunity";
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const has = items.filter(Boolean).length > 0;
  return (
    <div
      className="flex flex-col rounded-xl border border-border/80 bg-card/70"
      style={{ borderTopColor: `var(--${tone})`, borderTopWidth: 3 }}
    >
      <div className="border-b border-border/60 px-4 py-3">
        <h2 className="font-heading text-xl text-primary">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-3">
        {has ? children : (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            {empty}
          </p>
        )}
      </div>
    </div>
  );
}
