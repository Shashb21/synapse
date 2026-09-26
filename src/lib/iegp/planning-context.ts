import type { IegpState } from "./types";

/**
 * The context of one IEGP, captured in the setup wizard and stored per
 * workspace in `assets.planning_context`. The asset row and the objectives
 * table mirror the parts other stages already read (name, INN, indication,
 * geography, objectives with their key decisions and dates); everything else
 * lives only here and reaches the stages through `prioritizationContextFromState`.
 */

export const LIFECYCLE_STAGES = [
  { id: "pre-launch", label: "Pre-launch" },
  { id: "launch", label: "Launch" },
  { id: "growth", label: "Growth" },
  { id: "loe", label: "Loss of exclusivity (LoE)" },
] as const;

export const PRESSURE_LEVELS = ["low", "medium", "high"] as const;
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

/** Functions usually involved in an IEGP; the wizard also accepts any other name. */
export const PLAN_FUNCTIONS = [
  "Medical Affairs",
  "HEOR",
  "Market Access",
  "Clinical Development",
  "Commercial",
  "Regulatory",
  "RWE / Epidemiology",
  "Patient Engagement",
] as const;

export const SUGGESTED_SETTINGS = ["1L", "2L", "3L+", "Adjuvant", "Neoadjuvant", "Perioperative", "Maintenance"] as const;

export type SetupIndication = { name: string; status: "current" | "planned" };
export type SetupObjective = {
  /** Id of the objectives row; empty for an objective not saved yet. */
  id: string;
  name: string;
  description: string;
  strategic_importance: number;
  owner: string;
  key_decision: string;
  decision_date: string;
};
export type SetupCompetitor = { name: string; pressure: PressureLevel; note: string };
export type SetupMilestone = { name: string; date: string };
export type SetupStakeholder = { function: string; lead: string };

export type PlanningContext = {
  // Asset
  asset_name: string;
  inn: string;
  mechanism: string;
  modality: string;
  therapeutic_area: string;
  indications: SetupIndication[];
  lifecycle_stage: string;
  markets: string[];
  /** Derived: the current indications, for stages that read one string. */
  indication: string;
  /** Derived: the markets, for stages that read one string. */
  geography: string;
  // Company & plan
  company_situation: string;
  plan_owner: string;
  sponsoring_function: string;
  plan_horizon_years: number;
  cycle_start: string;
  cycle_end: string;
  // Objectives & key decisions
  objectives: SetupObjective[];
  /** Derived from the first objective: the plan's primary decision. */
  key_decision: string;
  decision_date: string;
  strategic_importance: number;
  // Evidence landscape
  competitors: SetupCompetitor[];
  competitive_pressure: PressureLevel | "";
  competitor_positioning: string;
  standard_of_care: string;
  comparators: string[];
  payer_hta_bodies: string[];
  regulatory_milestones: SetupMilestone[];
  launch_timeline: string;
  // People
  stakeholders: SetupStakeholder[];
  // Treatment settings (feed the Prioritize setting scopes)
  treatment_settings: string[];
  /** When the context was last saved from the wizard. */
  saved_at: string;
};

export const EMPTY_PLANNING_CONTEXT: PlanningContext = {
  asset_name: "",
  inn: "",
  mechanism: "",
  modality: "",
  therapeutic_area: "",
  indications: [],
  lifecycle_stage: "",
  markets: [],
  indication: "",
  geography: "",
  company_situation: "",
  plan_owner: "",
  sponsoring_function: "",
  plan_horizon_years: 3,
  cycle_start: "",
  cycle_end: "",
  objectives: [],
  key_decision: "",
  decision_date: "",
  strategic_importance: 3,
  competitors: [],
  competitive_pressure: "",
  competitor_positioning: "",
  standard_of_care: "",
  comparators: [],
  payer_hta_bodies: [],
  regulatory_milestones: [],
  launch_timeline: "",
  stakeholders: [],
  treatment_settings: [],
  saved_at: "",
};

const str = (value: unknown, max = 2000) => (typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : "");

function importanceOf(value: unknown, fallback = 3): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : fallback;
}

/** Trimmed, de-duplicated (case-insensitive) list of short tags; first spelling wins. */
export function tagList(value: unknown, max = 40): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = str(item, 80).replace(/\s+/g, " ");
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];
}

/** Older contexts said "peri-launch"; the wizard's stages are pre-launch / launch / growth / LoE. */
export function normalizeLifecycle(value: unknown): string {
  const raw = str(value, 60).toLowerCase();
  if (!raw) return "";
  if (raw === "peri-launch" || raw === "peri launch" || raw === "perilaunch") return "launch";
  if (raw === "prelaunch" || raw === "pre launch") return "pre-launch";
  if (raw.startsWith("loss of exclusivity") || raw === "loe") return "loe";
  const known = LIFECYCLE_STAGES.find((stage) => stage.id === raw || stage.label.toLowerCase() === raw);
  return known ? known.id : str(value, 60);
}

export function lifecycleLabel(value: string): string {
  return LIFECYCLE_STAGES.find((stage) => stage.id === value)?.label ?? value;
}

function pressureOf(value: unknown): PressureLevel | "" {
  const raw = str(value, 20).toLowerCase();
  return (PRESSURE_LEVELS as readonly string[]).includes(raw) ? (raw as PressureLevel) : "";
}

/** Reads a stored or submitted context; unknown keys are dropped, old flat contexts are upgraded. */
export function parsePlanningContext(raw: unknown): PlanningContext {
  if (!raw || typeof raw !== "object") return structuredClone(EMPTY_PLANNING_CONTEXT);
  const row = raw as Record<string, unknown>;

  let indications: SetupIndication[] = rows(row.indications)
    .map((item) => ({ name: str(item.name, 200), status: item.status === "planned" ? ("planned" as const) : ("current" as const) }))
    .filter((item) => item.name);
  if (indications.length === 0 && str(row.indication)) indications = [{ name: str(row.indication, 200), status: "current" }];

  let markets = tagList(row.markets);
  if (markets.length === 0 && str(row.geography)) markets = tagList(str(row.geography).split(/\s*[+,;/]\s*/));

  const objectives: SetupObjective[] = rows(row.objectives)
    .map((item) => ({
      id: str(item.id, 80),
      name: str(item.name, 300),
      description: str(item.description, 1000),
      strategic_importance: importanceOf(item.strategic_importance),
      owner: str(item.owner, 120),
      key_decision: str(item.key_decision, 300),
      decision_date: str(item.decision_date, 10),
    }))
    .filter((item) => item.name || item.key_decision || item.id);

  const primary = objectives[0];
  const current = indications.filter((item) => item.status === "current").map((item) => item.name);
  const horizon = Math.round(Number(row.plan_horizon_years));

  return {
    asset_name: str(row.asset_name, 200),
    inn: str(row.inn, 200),
    mechanism: str(row.mechanism, 300),
    modality: str(row.modality, 120),
    therapeutic_area: str(row.therapeutic_area, 200),
    indications,
    lifecycle_stage: normalizeLifecycle(row.lifecycle_stage),
    markets,
    indication: current.length ? current.join("; ") : str(row.indication, 400),
    geography: markets.length ? markets.join(" + ") : str(row.geography, 400),
    company_situation: str(row.company_situation, 4000),
    plan_owner: str(row.plan_owner, 200),
    sponsoring_function: str(row.sponsoring_function, 120),
    plan_horizon_years: Number.isFinite(horizon) && horizon >= 1 && horizon <= 15 ? horizon : 3,
    cycle_start: str(row.cycle_start, 10),
    cycle_end: str(row.cycle_end, 10),
    objectives,
    key_decision: primary?.key_decision || str(row.key_decision, 300),
    decision_date: primary?.decision_date || str(row.decision_date, 10),
    strategic_importance: primary ? primary.strategic_importance : importanceOf(row.strategic_importance),
    competitors: rows(row.competitors)
      .map((item) => ({ name: str(item.name, 200), pressure: pressureOf(item.pressure) || ("medium" as const), note: str(item.note, 500) }))
      .filter((item) => item.name),
    competitive_pressure: pressureOf(row.competitive_pressure),
    competitor_positioning: str(row.competitor_positioning, 2000),
    standard_of_care: str(row.standard_of_care, 1000),
    comparators: tagList(row.comparators),
    payer_hta_bodies: tagList(row.payer_hta_bodies),
    regulatory_milestones: rows(row.regulatory_milestones)
      .map((item) => ({ name: str(item.name, 200), date: str(item.date, 10) }))
      .filter((item) => item.name),
    launch_timeline: str(row.launch_timeline, 1000),
    stakeholders: rows(row.stakeholders)
      .map((item) => ({ function: str(item.function, 120), lead: str(item.lead, 200) }))
      .filter((item) => item.function),
    treatment_settings: tagList(row.treatment_settings),
    saved_at: str(row.saved_at, 40),
  };
}

// ---------------------------------------------------------------------------
// Wizard steps and validation

export const SETUP_SECTIONS = [
  { id: "asset", label: "Asset" },
  { id: "company", label: "Company & plan" },
  { id: "objectives", label: "Objectives & decisions" },
  { id: "landscape", label: "Evidence landscape" },
  { id: "stakeholders", label: "Stakeholders" },
  { id: "settings", label: "Treatment settings" },
] as const;
export type SetupSection = (typeof SETUP_SECTIONS)[number]["id"];

export type SetupIssue = { section: SetupSection; field: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * What is missing or malformed. `required` issues block finishing the wizard;
 * a draft (saved on each Continue) is only refused for malformed values.
 */
export function setupIssues(ctx: PlanningContext, opts: { required?: boolean } = {}): SetupIssue[] {
  const required = opts.required ?? true;
  const issues: SetupIssue[] = [];
  const need = (section: SetupSection, field: string, ok: boolean, message: string) => {
    if (required && !ok) issues.push({ section, field, message });
  };
  const date = (section: SetupSection, field: string, value: string, label: string) => {
    if (value && !validDate(value)) issues.push({ section, field, message: `${label} must be a date (YYYY-MM-DD).` });
  };

  need("asset", "asset_name", Boolean(ctx.asset_name), "Name the asset.");
  need("asset", "therapeutic_area", Boolean(ctx.therapeutic_area), "Give the therapeutic area.");
  need("asset", "indications", ctx.indications.some((item) => item.status === "current"), "Add at least one current indication.");
  need("asset", "lifecycle_stage", Boolean(ctx.lifecycle_stage), "Pick the lifecycle stage.");
  need("asset", "markets", ctx.markets.length > 0, "Add at least one market in scope.");

  need("company", "plan_owner", Boolean(ctx.plan_owner), "Name the plan owner.");
  need("company", "sponsoring_function", Boolean(ctx.sponsoring_function), "Pick the sponsoring function.");
  date("company", "cycle_start", ctx.cycle_start, "Planning cycle start");
  date("company", "cycle_end", ctx.cycle_end, "Planning cycle end");
  if (validDate(ctx.cycle_start) && validDate(ctx.cycle_end) && ctx.cycle_end < ctx.cycle_start) {
    issues.push({ section: "company", field: "cycle_end", message: "The planning cycle must end after it starts." });
  }

  need("objectives", "objectives", ctx.objectives.length > 0, "Add at least one strategic objective.");
  ctx.objectives.forEach((objective, index) => {
    if (required && !objective.name) issues.push({ section: "objectives", field: `objectives.${index}.name`, message: `Objective ${index + 1} needs a name.` });
    date("objectives", `objectives.${index}.decision_date`, objective.decision_date, `Objective ${index + 1} decision date`);
    if (required && objective.decision_date && !objective.key_decision) {
      issues.push({
        section: "objectives",
        field: `objectives.${index}.key_decision`,
        message: `Objective ${index + 1} has a decision date but no key decision.`,
      });
    }
  });
  need(
    "objectives",
    "key_decision",
    ctx.objectives.some((objective) => objective.key_decision && objective.decision_date),
    "Add at least one key decision with its date.",
  );

  ctx.regulatory_milestones.forEach((milestone, index) =>
    date("landscape", `regulatory_milestones.${index}.date`, milestone.date, `Milestone “${milestone.name}” date`),
  );

  need("stakeholders", "stakeholders", ctx.stakeholders.length > 0, "Add at least one function involved.");
  return issues;
}

export function sectionIssues(ctx: PlanningContext, section: SetupSection): SetupIssue[] {
  return setupIssues(ctx).filter((issue) => issue.section === section);
}

// ---------------------------------------------------------------------------
// Loading and use by the stages

/**
 * The context the wizard starts from. A saved context wins; otherwise an
 * existing plan (seeded or built before the wizard existed) prefills from the
 * asset row and objectives. A brand-new workspace starts empty rather than
 * showing the template asset every blank workspace is created with.
 */
export function setupContextFromState(state: IegpState, opts: { fresh?: boolean } = {}): PlanningContext {
  const parsed = parsePlanningContext(state.asset.planning_context);
  const untouched =
    !parsed.saved_at && !parsed.asset_name && state.sources.length === 0 && state.gaps.length === 0 && state.tactics.length === 0;
  if ((opts.fresh || untouched) && !parsed.saved_at) return parsed;

  const next = { ...parsed };
  if (!next.asset_name) {
    Object.assign(
      next,
      parsePlanningContext({
        ...state.asset.planning_context as object,
        asset_name: state.asset.name,
        inn: state.asset.inn,
        indication: state.asset.indication,
        geography: state.asset.geography,
      }),
    );
  }
  if (next.objectives.length === 0 && state.objectives.length > 0) {
    next.objectives = state.objectives.map((objective) => ({
      id: objective.id,
      name: objective.name,
      description: objective.description,
      strategic_importance: importanceOf(objective.strategic_importance),
      owner: objective.owner,
      key_decision: objective.key_decision,
      decision_date: objective.decision_date,
    }));
    if (!next.lifecycle_stage) next.lifecycle_stage = normalizeLifecycle(state.objectives[0]?.lifecycle_stage);
  }
  return parsePlanningContext(next);
}

const orUndefined = <T,>(list: T[]) => (list.length ? list : undefined);

/**
 * Context block passed to the S8 prioritization and S10 timeline LLMs (S8
 * merges per-run overrides on top). The first seven keys are the ones S8's
 * input schema names; the rest is the wider IEGP context from the wizard.
 */
export function prioritizationContextFromState(state: IegpState) {
  const planning = parsePlanningContext(state.asset.planning_context);
  const objective = state.objectives[0];
  const pressure = [
    planning.competitive_pressure && `Overall competitive pressure: ${planning.competitive_pressure}.`,
    planning.competitor_positioning,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    key_decision: planning.key_decision || objective?.key_decision || undefined,
    decision_date: planning.decision_date || objective?.decision_date || undefined,
    competitor_pressure: pressure || undefined,
    launch_timeline: planning.launch_timeline || undefined,
    company_situation: planning.company_situation || undefined,
    lifecycle_stage: planning.lifecycle_stage || objective?.lifecycle_stage || undefined,
    strategic_importance: planning.strategic_importance || objective?.strategic_importance,
    therapeutic_area: planning.therapeutic_area || undefined,
    mechanism: [planning.mechanism, planning.modality].filter(Boolean).join(" · ") || undefined,
    indications: orUndefined(planning.indications.map((item) => `${item.name} (${item.status})`)),
    markets: orUndefined(planning.markets),
    plan: planning.plan_owner
      ? {
          owner: planning.plan_owner,
          sponsoring_function: planning.sponsoring_function || undefined,
          horizon_years: planning.plan_horizon_years,
          cycle: planning.cycle_start || planning.cycle_end ? `${planning.cycle_start || "?"} to ${planning.cycle_end || "?"}` : undefined,
        }
      : undefined,
    objectives: orUndefined(
      planning.objectives.map((item) => ({
        name: item.name,
        strategic_importance: item.strategic_importance,
        key_decision: item.key_decision || undefined,
        decision_date: item.decision_date || undefined,
      })),
    ),
    competitors: orUndefined(planning.competitors.map((item) => `${item.name} (${item.pressure} pressure)${item.note ? `: ${item.note}` : ""}`)),
    standard_of_care: planning.standard_of_care || undefined,
    comparators: orUndefined(planning.comparators),
    payer_hta_bodies: orUndefined(planning.payer_hta_bodies),
    regulatory_milestones: orUndefined(planning.regulatory_milestones.map((item) => `${item.name}${item.date ? ` (${item.date})` : ""}`)),
    stakeholders: orUndefined(planning.stakeholders.map((item) => `${item.function}${item.lead ? `: ${item.lead}` : ""}`)),
    treatment_settings: orUndefined(planning.treatment_settings),
  };
}

/** The treatment settings named in setup: offered as setting tags on Gaps and scopes on Prioritize. */
export function plannedSettings(state: Pick<IegpState, "asset">): string[] {
  return parsePlanningContext(state.asset.planning_context).treatment_settings;
}
