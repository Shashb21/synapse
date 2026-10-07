/**
 * The AI sections of the app (owner, 2026-09-30, KAN-53): the Synapse admin turns AI on or
 * off per section, for every customer. Customers have no AI switch; a section that is off
 * shows its manual flow only. Client-safe: no server imports.
 */
export const AI_SECTIONS = [
  {
    id: "ingestion",
    label: "Ingestion",
    stages: ["S0", "S1"],
    detail: "Reads uploaded sources into blocks (S1 parse).",
    built: true,
  },
  {
    id: "gap_extraction",
    label: "Gap extraction",
    stages: ["S2"],
    detail: "Proposes evidence gaps from parsed sources (S2).",
    built: true,
  },
  {
    id: "tactic_extraction",
    label: "Tactic extraction",
    stages: ["S3"],
    detail: "Finds existing tactics in parsed sources (S3).",
    built: true,
  },
  {
    id: "mapping",
    label: "Gap ↔ tactic mapping",
    stages: ["S4"],
    detail: "Suggests which tactics cover which gaps, with a coverage verdict (S4).",
    built: true,
  },
  {
    id: "gap_status",
    label: "Gap status",
    stages: ["S5"],
    detail: "Status is computed by rules from the mappings and confirmed by a person. No AI module is developed yet.",
    built: false,
  },
  {
    id: "partial_split",
    label: "Partially addressed: suggested split",
    stages: ["S6"],
    detail: "Suggests how to split a partially addressed gap into addressed and open parts (S6).",
    built: true,
  },
  {
    id: "prioritization",
    label: "Gap prioritization",
    stages: ["S8"],
    detail: "Places gaps on the matrix as a first draft for a person to move and validate (S8).",
    built: true,
  },
  {
    id: "ideation",
    label: "High-priority tactic ideation",
    stages: ["S9"],
    detail: "Designs candidate tactics for gaps validated as High (S9).",
    built: true,
  },
] as const;

export type AiSectionId = (typeof AI_SECTIONS)[number]["id"];
export type AiSections = Record<AiSectionId, boolean>;

export const AI_SECTION_IDS = AI_SECTIONS.map((section) => section.id) as AiSectionId[];

/** Every section off: the default until the admin turns one on (owner: AI off by default). */
export function noAiSections(): AiSections {
  return Object.fromEntries(AI_SECTION_IDS.map((id) => [id, false])) as AiSections;
}

/** The section a stage belongs to, or null for a stage with no AI (S7, S10). */
export function sectionOfStage(stage: string): AiSectionId | null {
  return AI_SECTIONS.find((section) => (section.stages as readonly string[]).includes(stage))?.id ?? null;
}

export function isAiSectionId(value: unknown): value is AiSectionId {
  return typeof value === "string" && (AI_SECTION_IDS as string[]).includes(value);
}
