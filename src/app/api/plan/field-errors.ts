import type { z } from "zod";

/**
 * Validation errors the plan API returns to a dialog. They name a field by the
 * label a person sees ("Start date", "Payer / HTA relevance score"), never by
 * the request field ("start_date", "y_score"), and read as one sentence.
 */

const FIELD_LABELS: Record<string, string> = {
  band: "Band",
  decision: "Decision",
  start_date: "Start date",
  end_date: "End date",
  readout_date: "Readout date",
  lane: "Lane",
  type: "Tactic type",
  depends_on: "Dependencies",
  reasons: "Dependency reasons",
  status: "Plan status",
  duration_months: "Duration (months)",
  readout_lag_months: "Readout lag (months)",
  x_score: "Horizontal axis score",
  y_score: "Vertical axis score",
};

/** The label for a request field: a known one, else the name made readable ("x_axis" → "X axis"). */
export function fieldLabel(name: string): string {
  const known = FIELD_LABELS[name];
  if (known) return known;
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One validation issue as the end of a sentence that starts with the field label. */
function issueText(issue: z.core.$ZodIssue): string {
  if (issue.message.startsWith("must ")) return issue.message;
  if (issue.code === "invalid_value") {
    return `must be one of: ${issue.values.map(String).join(", ")}`;
  }
  if (issue.code === "invalid_type") return "is missing or not valid";
  return `is not valid (${issue.message})`;
}

/** "Start date must be a date (YYYY-MM-DD)." from a failed parse. */
export function fieldErrorMessage(label: string, issues: z.core.$ZodIssue[]): string {
  return `${label} ${issues.map(issueText).join("; ")}.`;
}

/**
 * Parses one request field, or throws an error that names it by its label so
 * the dialog can show it as is. `label` overrides the default for `name`.
 */
export function field<T>(schema: z.ZodType<T>, value: unknown, name: string, label = fieldLabel(name)): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(fieldErrorMessage(label, parsed.error.issues));
  return parsed.data;
}

/** An optional 0–100 score: empty or absent is "not given". `label` names it in the error. */
export function optionalScore(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`${label} must be a number from 0 to 100.`);
  }
  return score;
}

/** Months for an idea's timing: empty is null (left for S10), absent is unchanged. */
export function optionalMonths(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === "") return null;
  const months = Number(value);
  if (!Number.isFinite(months)) throw new Error(`${fieldLabel(name)} must be a number of months.`);
  return months;
}
