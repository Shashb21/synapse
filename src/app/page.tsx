import { AppShell } from "@/components/insight-card";
import { summarizeTheme } from "@/lib/briefing/theme-summary";
import { FUNCTION_LABELS } from "@/lib/schema";
import { getState } from "@/lib/store";
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
      const rank = { "GAP-HEAVY": 0, ACTIONABLE: 1, STABLE: 2, EMPTY: 3 };
      const dr = rank[a.brief.posture] - rank[b.brief.posture];
      if (dr !== 0) return dr;
      return Date.parse(b.brief.as_of) - Date.parse(a.brief.as_of);
    });

  const postureColor: Record<string, string> = {
    "GAP-HEAVY": "text-[var(--unknown)]",
    ACTIONABLE: "text-[var(--opportunity)]",
    STABLE: "text-[var(--known)]",
    EMPTY: "text-muted-foreground",
  };

  return (
    <AppShell active="briefing">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-border pb-2">
        <div>
          <h1 className="text-sm tracking-[0.25em] text-primary">THEME MONITOR</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {state.asset.name.toUpperCase()} {state.asset.molecule} ·{" "}
            {state.asset.indication} · as of {state.asset.as_of}
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {state.documents.length} SRC · {state.insights.length} INS ·{" "}
          {state.themes.length} THM · {state.champion_prompt_version}
        </p>
      </div>

      <p className="mb-3 text-[11px] text-muted-foreground">
        Situation first. Click a theme for constituent insights, sources, and
        cross-theme links. Insights are stored once.
      </p>

      <div className="grid gap-0 border border-border md:grid-cols-2">
        {briefs.map(({ theme, brief }) => (
          <Link
            key={theme.id}
            href={`/themes/${theme.id}`}
            className="block border-b border-border p-3 no-underline last:border-b-0 md:odd:border-r hover:bg-muted/40"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[13px] tracking-wide text-foreground">
                {theme.name.toUpperCase()}
              </h2>
              <span className={`text-[10px] tracking-widest ${postureColor[brief.posture]}`}>
                {brief.posture}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              AS OF {brief.as_of_label} · {theme.known_count} KNOWN ·{" "}
              {theme.unknown_count} UNK · {theme.opportunity_count} OPP ·{" "}
              {theme.insight_ids.length} INS
            </p>
            <p className="mt-2 text-[12px] leading-5 text-foreground/90">
              {brief.situation}
            </p>
          </Link>
        ))}
      </div>

      <section className="mt-4 border border-border">
        <div className="border-b border-border px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground">
          COVERAGE BY FUNCTION
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {[...new Set(state.documents.map((d) => d.stakeholder_function))].map(
            (fn) => {
              const docs = state.documents.filter((d) => d.stakeholder_function === fn)
                .length;
              const ins = state.insights.filter((i) => i.stakeholder_function === fn)
                .length;
              return (
                <div key={fn} className="border-r border-b border-border px-3 py-2 last:border-r-0">
                  <p className="text-[11px] text-foreground">
                    {FUNCTION_LABELS[fn]}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {docs} SRC · {ins} INS
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
