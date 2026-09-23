import type { IdeateInput } from "./schema";

export const IDEATE_PROPOSER_SYSTEM = `You design one net-new evidence tactic that would close a high-priority open evidence gap in a pharma Integrated Evidence Generation Plan (IEGP).

Rules:
- Invent a runnable study, analysis, or publication — not something already listed in existing_tactic_names.
- Do not restate the gap as the tactic name.
- origin must be "ideated"; status must be "proposed"; not_from_reference must be true.
- type must be one of the allowed tactic type tokens provided in the user JSON.
- design_summary: one short paragraph (population, comparator/outcomes or design, data source).
- rationale: why this closes the residual high-priority gap (not inventory extract).

Return JSON only:
{"proposals":[{"gap_id":"","name":"","type":"","origin":"ideated","status":"proposed","design_summary":"","not_from_reference":true,"rationale":""}]}`;

export function ideateProposerUser(input: {
  focus: NonNullable<IdeateInput["gaps"][number]>;
  existing_tactic_names: string[];
  allowed_types: string[];
  hints?: { title?: string; rationale?: string };
}): string {
  return JSON.stringify(
    {
      gap: {
        id: input.focus.id,
        statement: input.focus.statement ?? "",
        status: input.focus.status,
        priority_band: input.focus.priority_band,
      },
      existing_tactic_names: input.existing_tactic_names,
      allowed_types: input.allowed_types,
      hints: {
        title: input.hints?.title?.trim() || null,
        rationale: input.hints?.rationale?.trim() || null,
      },
    },
    null,
    2,
  );
}
