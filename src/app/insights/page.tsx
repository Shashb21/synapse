import { AppShell, InsightCard, PageIntro } from "@/components/insight-card";
import { ThemeChip } from "@/components/theme-chip";
import { RESIDUAL_THEME_ID } from "@/lib/cluster/cluster";
import { CLASS_LABELS, type InsightClass } from "@/lib/schema";
import { getState } from "@/lib/store";
import { CLASS_STYLES } from "@/lib/theme-style";
import Link from "next/link";

export const dynamic = "force-dynamic";

const CLASSES: InsightClass[] = ["unknown", "opportunity", "known"];

function href(next: { theme?: string; cls?: string }) {
  const params = new URLSearchParams();
  if (next.theme) params.set("theme", next.theme);
  if (next.cls) params.set("cls", next.cls);
  const q = params.toString();
  return q ? `/insights?${q}` : "/insights";
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; cls?: string }>;
}) {
  const { theme: themeId, cls } = await searchParams;
  const state = await getState();
  const classFilter = CLASSES.includes(cls as InsightClass)
    ? (cls as InsightClass)
    : undefined;
  const unassigned = state.insights.filter((i) =>
    i.theme_ids.includes(RESIDUAL_THEME_ID),
  );

  const filtered = state.insights
    .filter((insight) =>
      themeId ? insight.theme_ids.includes(themeId) : true,
    )
    .filter((insight) =>
      classFilter ? insight.classification === classFilter : true,
    )
    .sort((a, b) => {
      const order = { unknown: 0, opportunity: 1, known: 2 };
      const dr = order[a.classification] - order[b.classification];
      if (dr !== 0) return dr;
      const residual =
        Number(b.theme_ids.includes(RESIDUAL_THEME_ID)) -
        Number(a.theme_ids.includes(RESIDUAL_THEME_ID));
      if (residual !== 0) return residual;
      return Date.parse(b.extracted_at) - Date.parse(a.extracted_at);
    });

  const docs = state.documents.map((d) => ({
    id: d.id,
    title: d.title,
    filename: d.filename,
  }));

  const chip = (active: boolean) =>
    `rounded-md px-2 py-1 text-[12px] no-underline ${
      active
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
    }`;

  return (
    <AppShell active="insights">
      <PageIntro title="All insights">
        <p>
          Every CIR in one list. Themes link to the same row — nothing is
          copied. Claims that miss the catalog floor wait in Unassigned instead
          of being forced into Access, Evidence, or whatever scored highest.
        </p>
        <p className="mt-2 text-sm">
          {state.insights.length} insights · {unassigned.length} unassigned
        </p>
      </PageIntro>

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={href({ cls: classFilter })} className={chip(!themeId)}>
          All themes
        </Link>
        {state.themes.map((theme) => (
          <ThemeChip
            key={theme.id}
            id={theme.id}
            name={
              theme.id === RESIDUAL_THEME_ID
                ? `Unassigned (${unassigned.length})`
                : theme.name
            }
            href={href({
              theme: theme.id === themeId ? undefined : theme.id,
              cls: classFilter,
            })}
            current={theme.id === themeId}
          />
        ))}
      </div>

      <div className="mb-8 flex flex-wrap gap-2">
        <Link href={href({ theme: themeId })} className={chip(!classFilter)}>
          All classes
        </Link>
        {CLASSES.map((value) => {
          const s = CLASS_STYLES[value];
          const active = classFilter === value;
          return (
            <Link
              key={value}
              href={href({
                theme: themeId,
                cls: active ? undefined : value,
              })}
              className="rounded-md border px-2 py-1 text-[12px] no-underline"
              style={{
                color: s.fg,
                backgroundColor: active ? s.bg : "transparent",
                borderColor: active ? s.border : "transparent",
              }}
            >
              {CLASS_LABELS[value]}
            </Link>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="border border-border bg-card p-6 text-[13px] leading-5 text-muted-foreground">
          {themeId === RESIDUAL_THEME_ID
            ? "Unassigned is empty. New readouts that do not clear the catalog floor will land here, held once, so they can propose a new theme instead of being smeared into an existing one."
            : "No insights match these filters."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              currentThemeId={themeId}
              themes={state.themes}
              documents={docs}
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}
