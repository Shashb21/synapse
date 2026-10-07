"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  TACTIC_STATUSES,
  TACTIC_TYPES,
  TACTIC_TYPE_LABELS,
} from "@/lib/iegp/enums";
import { blankToNull } from "@/components/accuracy/claim-api";

export type ClaimKind = "gap" | "tactic";

export type TacticOption = { id: string; statement: string };

/** Editable values for one claim (strings for inputs; "" = empty). */
export type ClaimFieldValues = {
  statement: string;
  external_id: string;
  provenance_quote: string;
  status_override: "" | "open" | "partial" | "addressed";
  type: string;
  tactic_status: string;
  evidence_question: string;
  design_summary: string;
  start: string;
  end: string;
  readout: string;
  depends_on: string[];
};

export const EMPTY_CLAIM_FIELDS: ClaimFieldValues = {
  statement: "",
  external_id: "",
  provenance_quote: "",
  status_override: "",
  type: "",
  tactic_status: "",
  evidence_question: "",
  design_summary: "",
  start: "",
  end: "",
  readout: "",
  depends_on: [],
};

const GAP_KEYS = ["statement", "external_id", "provenance_quote", "status_override"] as const;
const TACTIC_KEYS = [
  "statement",
  "external_id",
  "provenance_quote",
  "type",
  "tactic_status",
  "evidence_question",
  "design_summary",
  "start",
  "end",
  "readout",
  "depends_on",
] as const;

function wireValue(key: keyof ClaimFieldValues, values: ClaimFieldValues): unknown {
  if (key === "depends_on") return [...values.depends_on].sort();
  if (key === "statement") return values.statement.trim();
  if (key === "tactic_status") return values.tactic_status || undefined;
  return blankToNull(String(values[key]));
}

/**
 * Only the fields the user changed (so untouched AI values are not
 * human-locked). `initial` = null means "create": send every non-empty field.
 */
export function claimPatchFromValues(
  kind: ClaimKind,
  values: ClaimFieldValues,
  initial: ClaimFieldValues | null,
): Record<string, unknown> {
  const keys = kind === "gap" ? GAP_KEYS : TACTIC_KEYS;
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const next = wireValue(key, values);
    if (initial) {
      const prev = wireValue(key, initial);
      if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) continue;
      if (key === "tactic_status" && next === undefined) continue;
      patch[key] = next ?? null;
    } else {
      if (next == null || (Array.isArray(next) && next.length === 0)) continue;
      patch[key] = next;
    }
  }
  return patch;
}

const labelClass = "grid gap-1 text-[11px] text-muted-foreground";
const selectClass =
  "h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground";

export function ClaimFieldsForm({
  kind,
  values,
  onChange,
  tacticOptions = [],
  selfId,
  disabled,
  showStatusOverride = true,
  idPrefix,
}: {
  kind: ClaimKind;
  values: ClaimFieldValues;
  onChange: (next: ClaimFieldValues) => void;
  tacticOptions?: TacticOption[];
  selfId?: string;
  disabled?: boolean;
  showStatusOverride?: boolean;
  idPrefix: string;
}) {
  const set = <K extends keyof ClaimFieldValues>(key: K, value: ClaimFieldValues[K]) =>
    onChange({ ...values, [key]: value });
  const deps = tacticOptions.filter((row) => row.id !== selfId);

  return (
    <div className="grid gap-2">
      <label className={labelClass}>
        {kind === "tactic" ? "Tactic name" : "Gap statement"}
        <Textarea
          value={values.statement}
          onChange={(e) => set("statement", e.target.value)}
          rows={2}
          disabled={disabled}
          className="text-[12px]"
          data-testid={`${idPrefix}-statement`}
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={labelClass}>
          External / study ID
          <Input
            value={values.external_id}
            onChange={(e) => set("external_id", e.target.value)}
            disabled={disabled}
            className="h-8 text-[12px]"
          />
        </label>
        {kind === "gap" && showStatusOverride ? (
          <label className={labelClass}>
            Status override (beats derived status)
            <select
              value={values.status_override}
              onChange={(e) =>
                set("status_override", e.target.value as ClaimFieldValues["status_override"])
              }
              disabled={disabled}
              className={selectClass}
            >
              <option value="">No override — use derived status</option>
              <option value="open">Open</option>
              <option value="partial">Partial</option>
              <option value="addressed">Addressed</option>
            </select>
          </label>
        ) : null}
        {kind === "tactic" ? (
          <>
            <label className={labelClass}>
              Type
              <select
                value={values.type}
                onChange={(e) => set("type", e.target.value)}
                disabled={disabled}
                className={selectClass}
              >
                <option value="">—</option>
                {TACTIC_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TACTIC_TYPE_LABELS[type] ?? type}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Tactic status
              <select
                value={values.tactic_status}
                onChange={(e) => set("tactic_status", e.target.value)}
                disabled={disabled}
                className={selectClass}
              >
                <option value="">—</option>
                {TACTIC_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </div>
      {kind === "tactic" ? (
        <>
          <label className={labelClass}>
            Evidence question
            <Textarea
              value={values.evidence_question}
              onChange={(e) => set("evidence_question", e.target.value)}
              rows={2}
              disabled={disabled}
              className="text-[12px]"
            />
          </label>
          <label className={labelClass}>
            Design summary
            <Textarea
              value={values.design_summary}
              onChange={(e) => set("design_summary", e.target.value)}
              rows={2}
              disabled={disabled}
              className="text-[12px]"
            />
          </label>
          <ClaimScheduleFields
            values={values}
            onChange={onChange}
            tacticOptions={deps}
            disabled={disabled}
            idPrefix={idPrefix}
          />
        </>
      ) : null}
      <label className={labelClass}>
        Provenance quote
        <Textarea
          value={values.provenance_quote}
          onChange={(e) => set("provenance_quote", e.target.value)}
          rows={2}
          disabled={disabled}
          placeholder="Verbatim source quote backing this claim"
          className="text-[12px]"
        />
      </label>
    </div>
  );
}

/** Start / end / readout / depends_on — shared by the ledger editor and the Gantt board. */
export function ClaimScheduleFields({
  values,
  onChange,
  tacticOptions,
  disabled,
  idPrefix,
}: {
  values: Pick<ClaimFieldValues, "start" | "end" | "readout" | "depends_on">;
  onChange: (next: ClaimFieldValues) => void;
  tacticOptions: TacticOption[];
  disabled?: boolean;
  idPrefix: string;
}) {
  const full = values as ClaimFieldValues;
  const set = <K extends keyof ClaimFieldValues>(key: K, value: ClaimFieldValues[K]) =>
    onChange({ ...full, [key]: value });
  const toggleDep = (id: string) => {
    const has = values.depends_on.includes(id);
    set("depends_on", has ? values.depends_on.filter((row) => row !== id) : [...values.depends_on, id]);
  };
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className={labelClass}>
          Start
          <Input
            type="date"
            value={values.start}
            onChange={(e) => set("start", e.target.value)}
            disabled={disabled}
            className="h-8 text-[12px]"
            data-testid={`${idPrefix}-start`}
          />
        </label>
        <label className={labelClass}>
          End
          <Input
            type="date"
            value={values.end}
            onChange={(e) => set("end", e.target.value)}
            disabled={disabled}
            className="h-8 text-[12px]"
            data-testid={`${idPrefix}-end`}
          />
        </label>
        <label className={labelClass}>
          Readout / evidence available
          <Input
            type="date"
            value={values.readout}
            onChange={(e) => set("readout", e.target.value)}
            disabled={disabled}
            className="h-8 text-[12px]"
          />
        </label>
      </div>
      <fieldset className="grid gap-1">
        <legend className="text-[11px] text-muted-foreground">Depends on (waits for)</legend>
        {tacticOptions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No other tactics in this workspace.</p>
        ) : (
          <div className="max-h-32 overflow-y-auto border border-border p-2">
            {tacticOptions.map((row) => (
              <label key={row.id} className="flex items-start gap-2 text-[11px] text-foreground">
                <input
                  type="checkbox"
                  checked={values.depends_on.includes(row.id)}
                  onChange={() => toggleDep(row.id)}
                  disabled={disabled}
                  className="mt-0.5"
                />
                <span>
                  {row.statement} <span className="text-muted-foreground">{row.id}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
