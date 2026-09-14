export type ThemeStyle = {
  hue: string;
  fg: string;
  bg: string;
  border: string;
  glow: string;
};

export const THEME_STYLES: Record<string, ThemeStyle> = {
  "THEME-ACCESS": {
    hue: "#2dd4bf",
    fg: "#5eead4",
    bg: "rgba(45, 212, 191, 0.14)",
    border: "rgba(45, 212, 191, 0.42)",
    glow: "rgba(45, 212, 191, 0.22)",
  },
  "THEME-EVIDENCE": {
    hue: "#c084fc",
    fg: "#d8b4fe",
    bg: "rgba(192, 132, 252, 0.16)",
    border: "rgba(192, 132, 252, 0.42)",
    glow: "rgba(192, 132, 252, 0.22)",
  },
  "THEME-COMPETITIVE": {
    hue: "#fb7185",
    fg: "#fda4af",
    bg: "rgba(251, 113, 133, 0.14)",
    border: "rgba(251, 113, 133, 0.42)",
    glow: "rgba(251, 113, 133, 0.22)",
  },
  "THEME-SITE-OF-CARE": {
    hue: "#a3e635",
    fg: "#bef264",
    bg: "rgba(163, 230, 53, 0.14)",
    border: "rgba(163, 230, 53, 0.4)",
    glow: "rgba(163, 230, 53, 0.2)",
  },
  "THEME-TRIAL": {
    hue: "#38bdf8",
    fg: "#7dd3fc",
    bg: "rgba(56, 189, 248, 0.14)",
    border: "rgba(56, 189, 248, 0.42)",
    glow: "rgba(56, 189, 248, 0.22)",
  },
  "THEME-HCP": {
    hue: "#fbbf24",
    fg: "#fcd34d",
    bg: "rgba(251, 191, 36, 0.14)",
    border: "rgba(251, 191, 36, 0.42)",
    glow: "rgba(251, 191, 36, 0.22)",
  },
  "THEME-SEQUENCING": {
    hue: "#e879f9",
    fg: "#f0abfc",
    bg: "rgba(232, 121, 249, 0.14)",
    border: "rgba(232, 121, 249, 0.42)",
    glow: "rgba(232, 121, 249, 0.22)",
  },
  "THEME-POLICY": {
    hue: "#818cf8",
    fg: "#a5b4fc",
    bg: "rgba(129, 140, 248, 0.16)",
    border: "rgba(129, 140, 248, 0.42)",
    glow: "rgba(129, 140, 248, 0.22)",
  },
  "THEME-RESIDUAL": {
    hue: "#94a3b8",
    fg: "#cbd5e1",
    bg: "rgba(148, 163, 184, 0.12)",
    border: "rgba(148, 163, 184, 0.35)",
    glow: "rgba(148, 163, 184, 0.16)",
  },
};

export const POSTURE_STYLES: Record<
  string,
  { label: string; fg: string; bg: string }
> = {
  "GAP-HEAVY": {
    label: "Gap-heavy",
    fg: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.16)",
  },
  ACTIONABLE: {
    label: "Actionable",
    fg: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.16)",
  },
  STABLE: {
    label: "Stable",
    fg: "#34d399",
    bg: "rgba(52, 211, 153, 0.16)",
  },
  EMPTY: {
    label: "Empty",
    fg: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.12)",
  },
};

export const CLASS_STYLES: Record<
  "known" | "unknown" | "opportunity",
  { label: string; fg: string; bg: string; border: string }
> = {
  known: {
    label: "Known",
    fg: "#34d399",
    bg: "rgba(52, 211, 153, 0.16)",
    border: "rgba(52, 211, 153, 0.35)",
  },
  unknown: {
    label: "Unknown",
    fg: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.16)",
    border: "rgba(251, 191, 36, 0.35)",
  },
  opportunity: {
    label: "Opportunity",
    fg: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.16)",
    border: "rgba(56, 189, 248, 0.35)",
  },
};

export function themeStyle(id: string): ThemeStyle {
  return THEME_STYLES[id] ?? THEME_STYLES["THEME-RESIDUAL"]!;
}
