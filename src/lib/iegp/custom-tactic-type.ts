/**
 * A custom tactic type (KAN-51, from the design): a label and a colour a person gives a
 * tactic. It sits on top of the standard type, which the engine still uses for mapping,
 * dissemination and coverage rules, so a custom type never changes what a tactic counts as.
 */
export type CustomTacticType = { label: string; color: string };

export const CUSTOM_TYPE_LABEL_MAX = 40;

/** The design's preset swatches. */
export const CUSTOM_TYPE_COLORS = [
  "#4f46e5",
  "#0f766e",
  "#7e22ce",
  "#6366f1",
  "#15803d",
  "#1d4ed8",
  "#9a3412",
  "#374151",
  "#6b7280",
  "#6b21a8",
  "#b45309",
  "#0369a1",
  "#be185d",
  "#047857",
] as const;

const HEX = /^#[0-9a-f]{6}$/;

/** Cleaned custom type, or null when there is no label. A bad colour is refused, not guessed. */
export function normalizeCustomType(value: unknown): CustomTacticType | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === "string" ? raw.label.trim().replace(/\s+/g, " ") : "";
  if (!label) return null;
  if (label.length > CUSTOM_TYPE_LABEL_MAX) {
    throw new Error(`A custom type name can be at most ${CUSTOM_TYPE_LABEL_MAX} characters.`);
  }
  const color = typeof raw.color === "string" ? raw.color.trim().toLowerCase() : "";
  if (!HEX.test(color)) throw new Error("A custom type colour must be a hex colour like #4f46e5.");
  return { label, color };
}

/** Stored JSON back to a custom type; anything malformed reads as none. */
export function readCustomType(value: unknown): CustomTacticType | null {
  try {
    return normalizeCustomType(value);
  } catch {
    return null;
  }
}

/** Every custom type in use, one per label (case-insensitive), by label. */
export function customTypesInUse(tactics: { custom_type?: CustomTacticType | null }[]): CustomTacticType[] {
  const seen = new Map<string, CustomTacticType>();
  for (const tactic of tactics) {
    const custom = tactic.custom_type;
    if (custom && !seen.has(custom.label.toLowerCase())) seen.set(custom.label.toLowerCase(), custom);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}
