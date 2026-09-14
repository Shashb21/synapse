import type { CanonicalInsight, Theme } from "@/lib/schema";

export type ThemeSituation = {
  theme_id: string;
  as_of: string;
  as_of_label: string;
  posture: "GAP-HEAVY" | "ACTIONABLE" | "STABLE" | "EMPTY";
  situation: string;
  lead_known: string | null;
  lead_unknown: string | null;
  lead_opportunity: string | null;
};

function pick(insights: CanonicalInsight[], cls: CanonicalInsight["classification"]) {
  return [...insights.filter((i) => i.classification === cls)].sort(
    (a, b) => b.confidence - a.confidence,
  )[0];
}

export function formatTerminalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const mon = months[d.getUTCMonth()]!;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(2);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}-${mon}-${yy} ${hh}:${mm}Z`;
}

export function themeAsOf(insights: CanonicalInsight[], fallback: string): string {
  const times = insights
    .map((i) => Date.parse(i.extracted_at))
    .filter((n) => !Number.isNaN(n));
  if (times.length === 0) return fallback;
  return new Date(Math.max(...times)).toISOString();
}

function clip(text: string, n = 180): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function summarizeTheme(
  theme: Theme,
  insights: CanonicalInsight[],
  fallbackAsOf: string,
): ThemeSituation {
  const members = insights.filter((i) => i.theme_ids.includes(theme.id));
  const as_of = themeAsOf(members, fallbackAsOf);
  const known = pick(members, "known");
  const unknown = pick(members, "unknown");
  const opportunity = pick(members, "opportunity");

  let posture: ThemeSituation["posture"] = "STABLE";
  if (members.length === 0) posture = "EMPTY";
  else if (theme.unknown_count >= Math.max(1, theme.known_count)) posture = "GAP-HEAVY";
  else if (theme.opportunity_count > 0 && theme.unknown_count > 0) posture = "ACTIONABLE";

  const parts: string[] = [];
  if (theme.id === "THEME-RESIDUAL") {
    parts.push(
      "Did not clear the catalog floor. Held once in Unassigned — not dropped, and not mashed into the nearest theme. Humans name a new catalog entry from this queue.",
    );
  }
  if (known) parts.push(clip(known.statement));
  if (unknown) parts.push(`Gap: ${clip(unknown.statement, 140)}`);
  if (opportunity) parts.push(`Play: ${clip(opportunity.statement, 140)}`);
  if (parts.length === 0 && theme.id !== "THEME-RESIDUAL") {
    parts.push(theme.summary);
  }

  return {
    theme_id: theme.id,
    as_of,
    as_of_label: formatTerminalTime(as_of),
    posture,
    situation: parts.join(" "),
    lead_known: known?.statement ?? null,
    lead_unknown: unknown?.statement ?? null,
    lead_opportunity: opportunity?.statement ?? null,
  };
}
