import type { ActionField } from "@/components/platform/action-dialog";
import { TACTIC_TYPES, TACTIC_TYPE_LABELS, type TacticType } from "@/lib/iegp/enums";

export type ProposalFieldDefaults = {
  name?: string;
  type?: string;
  evidence_question?: string;
  rationale?: string;
  design?: {
    population?: string;
    comparator?: string;
    outcomes?: string;
    data_source?: string;
    study_design?: string;
    duration_months?: number | null;
    readout_lag_months?: number | null;
    timing_rationale?: string;
  };
};

const months = (value: number | null | undefined) => (typeof value === "number" ? String(value) : "");

/**
 * Every field of an idea, for writing one by hand or editing one the model
 * proposed. The API trims them; empty timing leaves it for S10 to estimate.
 */
export function proposalFields(defaults: ProposalFieldDefaults = {}): ActionField[] {
  const design = defaults.design ?? {};
  return [
    { name: "name", label: "Name", defaultValue: defaults.name ?? "", required: true },
    {
      name: "type",
      label: "Type",
      type: "select",
      defaultValue: defaults.type ?? TACTIC_TYPES[0],
      options: TACTIC_TYPES.map((value) => ({ value, label: TACTIC_TYPE_LABELS[value as TacticType] ?? value })),
    },
    {
      name: "evidence_question",
      label: "Evidence question",
      type: "textarea",
      defaultValue: defaults.evidence_question ?? "",
      required: true,
    },
    {
      name: "idea_rationale",
      label: "Why this closes the gap",
      type: "textarea",
      defaultValue: defaults.rationale ?? "",
      hint: "Left empty on a new idea, your edit rationale below is used.",
    },
    { name: "population", label: "Population", defaultValue: design.population ?? "" },
    { name: "comparator", label: "Comparator", defaultValue: design.comparator ?? "" },
    { name: "outcomes", label: "Outcomes", defaultValue: design.outcomes ?? "" },
    { name: "data_source", label: "Data source", defaultValue: design.data_source ?? "" },
    { name: "study_design", label: "Study design", defaultValue: design.study_design ?? "" },
    {
      name: "duration_months",
      label: "Duration (months, start to last data)",
      defaultValue: months(design.duration_months),
      placeholder: "e.g. 12",
      hint: "Leave empty to let the timeline estimate it.",
    },
    {
      name: "readout_lag_months",
      label: "Readout lag (months after last data)",
      defaultValue: months(design.readout_lag_months),
      placeholder: "e.g. 3",
    },
    {
      name: "timing_rationale",
      label: "Timing rationale",
      type: "textarea",
      defaultValue: design.timing_rationale ?? "",
    },
  ];
}
