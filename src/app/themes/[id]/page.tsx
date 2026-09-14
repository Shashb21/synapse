import { AppShell, InsightCard, PageIntro } from "@/components/insight-card";
import { PostureChip, ThemeChip } from "@/components/theme-chip";
import { summarizeTheme } from "@/lib/briefing/theme-summary";
import { getState } from "@/lib/store";
import { CLASS_STYLES, themeStyle } from "@/lib/theme-style";
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
  const color = themeStyle(theme.id);

  return (
    <AppShell active="briefing">
      <p className="mb-6 text-sm text-muted-foreground">
        <Link href="/" className="text-muted-foreground no-underline hover:text-foreground">
          Monitor
        </Link>
        <span className="mx-2">/</span>
        <span style={{ color: color.fg }}>{theme.name}</span>
      </p>
      <PageIntro title={theme.name}>
        <div className="flex flex-wrap items-center gap-3">
          <PostureChip posture={brief.posture} />
          <span className="text-sm">As of {brief.as_of_label}</span>
        </div>
        <p className="mt-4 text-foreground/90">{brief.situation}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              color: CLASS_STYLES.known.fg,
              backgroundColor: CLASS_STYLES.known.bg,
            }}
          >
            {theme.known_count} known
          </span>
          <span
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              color: CLASS_STYLES.unknown.fg,
              backgroundColor: CLASS_STYLES.unknown.bg,
            }}
          >
            {theme.unknown_count} unknown
          </span>
          <span
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              color: CLASS_STYLES.opportunity.fg,
              backgroundColor: CLASS_STYLES.opportunity.bg,
            }}
          >
            {theme.opportunity_count} opportunities
          </span>
        </div>
        <p className="mt-3 text-sm">
          The same insight may also sit on other themes — linked, not copied.
        </p>
      </PageIntro>

      {insights.length === 0 ? (
        <p className="text-base text-muted-foreground">No insights linked yet.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Insights</h2>
            <p className="text-sm text-muted-foreground">
              Unknowns first · {insights.length} in this theme
            </p>
          </div>
          {insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              currentThemeId={id}
              themes={state.themes}
              documents={docs}
            />
          ))}
        </div>
      )}

      <div className="mt-10">
        <h2 className="text-lg font-semibold">Other themes</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {state.themes
            .filter((t) => t.id !== id)
            .map((t) => (
              <ThemeChip key={t.id} id={t.id} name={t.name} href={`/themes/${t.id}`} />
            ))}
        </div>
      </div>
    </AppShell>
  );
}
