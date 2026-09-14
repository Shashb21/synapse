import { AppShell, PageIntro } from "@/components/insight-card";
import { PostureChip } from "@/components/theme-chip";
import { summarizeTheme } from "@/lib/briefing/theme-summary";
import { FUNCTION_LABELS } from "@/lib/schema";
import { getState } from "@/lib/store";
import { CLASS_STYLES, themeStyle } from "@/lib/theme-style";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function MonitorPage() {
  const state = await getState();
  const briefs = state.themes
    .map((theme) => ({
      theme,
      brief: summarizeTheme(theme, state.insights, state.asset.as_of),
    }))
    .sort((a, b) => {
      if (a.theme.id === "THEME-RESIDUAL") return 1;
      if (b.theme.id === "THEME-RESIDUAL") return -1;
      const rank = { "GAP-HEAVY": 0, ACTIONABLE: 1, STABLE: 2, EMPTY: 3 };
      const dr = rank[a.brief.posture] - rank[b.brief.posture];
      if (dr !== 0) return dr;
      return Date.parse(b.brief.as_of) - Date.parse(a.brief.as_of);
    });

  return (
    <AppShell active="briefing">
      <PageIntro kicker="Velmara" title="Theme monitor">
        <p>
          {state.asset.molecule} · {state.asset.indication}. Situation first —
          open a theme for the constituent insights, sources, and cross-theme
          links. Insights are stored once. Weak matches wait in Unassigned
          instead of being forced into a theme.
        </p>
        <p className="mt-2 text-sm">
          As of {state.asset.as_of} · {state.documents.length} sources ·{" "}
          {state.insights.length} insights · {state.themes.length} themes
        </p>
      </PageIntro>

      <div className="grid gap-5 md:grid-cols-2">
        {briefs.map(({ theme, brief }) => {
          const color = themeStyle(theme.id);
          return (
            <Link
              key={theme.id}
              href={`/themes/${theme.id}`}
              className="group relative block overflow-hidden rounded-2xl border bg-card p-6 no-underline shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg sm:p-7"
              style={{
                borderColor: color.border,
                background: `linear-gradient(165deg, ${color.bg} 0%, var(--card) 46%)`,
                boxShadow: `0 18px 40px -24px ${color.glow}`,
              }}
            >
              <span
                className="absolute inset-y-0 left-0 w-1.5"
                style={{ backgroundColor: color.hue }}
              />
              <div className="flex items-start justify-between gap-3 pl-2">
                <h2
                  className="text-xl font-semibold tracking-tight"
                  style={{ color: color.fg }}
                >
                  {theme.name}
                </h2>
                <PostureChip posture={brief.posture} />
              </div>
              <p className="mt-2 pl-2 text-sm text-muted-foreground">
                As of {brief.as_of_label}
              </p>
              <p className="mt-4 pl-2 text-[15px] leading-7 text-foreground/90">
                {brief.situation}
              </p>
              <div className="mt-5 flex flex-wrap gap-2 pl-2">
                <CountChip
                  label="Known"
                  count={theme.known_count}
                  color={CLASS_STYLES.known}
                />
                <CountChip
                  label="Unknown"
                  count={theme.unknown_count}
                  color={CLASS_STYLES.unknown}
                />
                <CountChip
                  label="Opportunity"
                  count={theme.opportunity_count}
                  color={CLASS_STYLES.opportunity}
                />
              </div>
            </Link>
          );
        })}
      </div>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-foreground">
          Coverage by function
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...new Set(state.documents.map((d) => d.stakeholder_function))].map(
            (fn) => {
              const docs = state.documents.filter(
                (d) => d.stakeholder_function === fn,
              ).length;
              const ins = state.insights.filter(
                (i) => i.stakeholder_function === fn,
              ).length;
              return (
                <div
                  key={fn}
                  className="rounded-2xl border border-border/80 bg-card px-5 py-4"
                >
                  <p className="text-base font-medium text-foreground">
                    {FUNCTION_LABELS[fn]}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {docs} sources · {ins} insights
                  </p>
                </div>
              );
            },
          )}
        </div>
      </section>
    </AppShell>
  );
}

function CountChip({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: { fg: string; bg: string };
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ color: color.fg, backgroundColor: color.bg }}
    >
      <span className="tabular-nums font-semibold">{count}</span>
      {label}
    </span>
  );
}
