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
  const openProposals = state.catalog_proposals.filter(
    (p) => p.status === "proposed",
  ).length;
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
          instead of being forced into a theme. The{" "}
          <Link href="/graph" className="underline">
            graph
          </Link>{" "}
          walks those joins for implications no single deck stated.
        </p>
        <p className="mt-2 text-sm">
          As of {state.asset.as_of} · {state.documents.length} sources ·{" "}
          {state.insights.length} insights · {state.themes.length} themes
        </p>
        {openProposals > 0 ? (
          <p className="mt-2 text-sm">
            {openProposals} catalog{" "}
            {openProposals === 1 ? "proposal" : "proposals"} waiting —{" "}
            <Link href="/catalog">review emerge and split</Link>
          </p>
        ) : null}
      </PageIntro>

      <div className="grid gap-3 md:grid-cols-2">
        {briefs.map(({ theme, brief }) => {
          const color = themeStyle(theme.id);
          return (
            <Link
              key={theme.id}
              href={`/themes/${theme.id}`}
              className="relative block border border-border bg-card p-4 no-underline hover:bg-muted/40"
            >
              <span
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ backgroundColor: color.hue }}
              />
              <div className="flex items-start justify-between gap-3 pl-3">
                <h2 className="text-[13px] font-medium text-foreground">
                  {theme.name}
                </h2>
                <PostureChip posture={brief.posture} />
              </div>
              <p className="mt-1 pl-3 text-xs text-muted-foreground">
                As of {brief.as_of_label}
              </p>
              <p className="mt-3 pl-3 text-[13px] leading-5 text-foreground/90">
                {brief.situation}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5 pl-3">
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

      <section className="mt-8">
        <h2 className="text-[13px] font-medium text-foreground">
          Coverage by function
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                  className="border border-border bg-card px-4 py-3"
                >
                  <p className="text-[13px] font-medium text-foreground">
                    {FUNCTION_LABELS[fn]}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
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
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: color.fg, backgroundColor: color.bg }}
    >
      <span className="tabular-nums font-semibold">{count}</span>
      {label}
    </span>
  );
}
