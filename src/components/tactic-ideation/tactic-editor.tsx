"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomTypeFields } from "@/components/custom-type-fields";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { TacticRecord } from "@/lib/iegp/tactic-record";
import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import { tacticDatesError } from "@/lib/iegp/tactic-dates";
import {
  ACTOR_FUNCTIONS,
  FUNCTION_LABELS,
  TACTIC_STATUSES,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";
import { postJson } from "@/lib/post-json";

const FIELD = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

/** The plain fields that go through `modify_tactic`; status has its own lock. */
const TEXT_FIELDS = ["name", "type", "evidence_question", "population", "intervention", "comparator", "outcomes", "study_design", "data_source", "geography", "start_date", "evidence_available", "budget", "owner", "function"] as const;

function customKey(value: CustomTacticType | null | undefined) {
  return value ? `${value.label.trim().toLowerCase()}|${value.color.toLowerCase()}` : "";
}

async function post(body: Record<string, unknown>) {
  const res = await postJson("/api/iegp", body);
  if (res.ok) return null;
  const json = res.json as { error?: string };
  return json.error ?? `Could not save (${res.status}).`;
}

export function TacticEditor({
  tactic: savedTactic,
  version: savedVersion,
  onDirtyChange,
  onPendingChange,
  onSaved,
  identity,
  inUse,
  onClose,
}: {
  tactic: TacticRecord["tactic"];
  version: string;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  onSaved?: () => void;
  identity: ActionIdentity;
  inUse: CustomTacticType[];
  onClose: () => void;
}) {
  // Revalidation updates the current details, never an open edit or its write token.
  const [tactic] = useState(savedTactic);
  const [version] = useState(savedVersion);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Close once the refreshed page data has arrived, so the row already shows the edit.
  const [refreshing, startRefresh] = useTransition();
  const closeAfterRefresh = useRef(false);
  useEffect(() => {
    if (!refreshing && closeAfterRefresh.current) {
      closeAfterRefresh.current = false;
      onDirtyChange?.(false);
      onSaved?.();
    }
  }, [refreshing, onSaved, onDirtyChange]);
  useEffect(() => { onPendingChange?.(pending || refreshing); }, [pending, refreshing, onPendingChange]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (name: string) => String(data.get(name) ?? "").trim();
    const current: Record<string, string> = {
      name: tactic.name,
      type: tactic.type,
      evidence_question: tactic.evidence_question,
      population: tactic.population, intervention: tactic.intervention, comparator: tactic.comparator,
      outcomes: tactic.outcomes, study_design: tactic.study_design, data_source: tactic.data_source, geography: tactic.geography,
      start_date: tactic.start_date ?? "",
      evidence_available: tactic.evidence_available ?? "",
      budget: tactic.budget ?? "",
      owner: tactic.owner,
      function: tactic.function,
    };
    const fields: Record<string, string> = {};
    for (const field of TEXT_FIELDS) {
      if (read(field) !== current[field]) fields[field] = read(field);
    }
    const customPosted = data.has("custom_type_label");
    const nextCustom = customPosted && read("custom_type_label")
      ? { label: read("custom_type_label"), color: read("custom_type_color") }
      : customPosted
        ? null
        : tactic.custom_type;
    const customChanged = customKey(nextCustom) !== customKey(tactic.custom_type);
    const status = read("status");
    const statusChanged = status !== tactic.status;
    const rationale = read("rationale");

    if (Object.keys(fields).length === 0 && !customChanged && !statusChanged) {
      setError("Nothing changed.");
      return;
    }
    // The dates as they will stand after the save, checked like the server does (KAN-68).
    const dateError = tacticDatesError(
      fields.start_date ?? current.start_date,
      fields.evidence_available ?? current.evidence_available,
    );
    if (dateError) {
      setError(dateError);
      return;
    }
    if (rationale.length < 3) {
      setError("A short rationale is required. It is stored with the edit.");
      return;
    }
    setPending(true);
    setError(null);
    const actor = { actor_name: identity.actor_name, actor_function: identity.actor_function };
    const failure = await post({
      action: "modify_tactic", tactic_id: tactic.id, expected_tactic: version,
      ...fields, ...(statusChanged ? { status } : {}),
      ...(customChanged ? { custom_type_label: nextCustom?.label ?? "", custom_type_color: nextCustom?.color ?? "" } : {}),
      rationale, ...actor,
    });
    setPending(false);
    if (failure) {
      setError(failure);
      return;
    }
    closeAfterRefresh.current = true;
    startRefresh(() => router.refresh());
  }

  return (
    <form onSubmit={submit} onChange={() => onDirtyChange?.(true)} className="flex min-h-full flex-col" aria-label={`Edit ${tactic.name}`}>
      <p className="text-[12px] text-muted-foreground">Every change needs a rationale and is kept on the edit record. The tactic evidence question is separate from each gap’s Evidence needed.</p>
      <div className="grid flex-1 gap-3 px-4 py-3">
        <label className={LABEL}>
          Tactic name
          <input name="name" required defaultValue={tactic.name} className={FIELD} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className={LABEL}>
            Type
            <select name="type" defaultValue={tactic.type} className={FIELD}>
              {TACTIC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TACTIC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Status
            <select name="status" defaultValue={tactic.status} className={FIELD}>
              {TACTIC_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>
        <CustomTypeFields initial={tactic.custom_type} inUse={inUse} clearable onChange={() => onDirtyChange?.(true)} />
        <label className={LABEL}>
          Evidence question
          <textarea
            name="evidence_question"
            required
            rows={3}
            defaultValue={tactic.evidence_question}
            className="w-full resize-none rounded-lg border border-input bg-card px-2.5 py-1.5 text-[12px] font-normal normal-case tracking-normal text-foreground"
          />
        </label>
        <details>
          <summary className="cursor-pointer">Study details</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {([['population', 'Population'], ['intervention', 'Intervention'], ['comparator', 'Comparator'], ['outcomes', 'Outcomes'], ['study_design', 'Study design'], ['data_source', 'Data source'], ['geography', 'Geography']] as const).map(([field, label]) => <label key={field} className={LABEL}>
              {label}<input name={field} defaultValue={tactic[field]} className={FIELD} />
            </label>)}
          </div>
        </details>
        <div className="grid grid-cols-2 gap-2">
          <label className={LABEL}>
            Start date
            <input name="start_date" type="text" placeholder="YYYY-MM or YYYY-MM-DD" defaultValue={tactic.start_date ?? ""} className={FIELD} />
          </label>
          <label className={LABEL}>
            Evidence available
            <input name="evidence_available" type="text" placeholder="YYYY-MM or YYYY-MM-DD" defaultValue={tactic.evidence_available ?? ""} className={FIELD} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className={LABEL}>
            Budget
            <input name="budget" placeholder="e.g. $500K" maxLength={60} defaultValue={tactic.budget ?? ""} className={FIELD} />
          </label>
          <label className={LABEL}>
            Lead function
            <select name="function" defaultValue={tactic.function} className={FIELD}>
              {ACTOR_FUNCTIONS.map((fn) => (
                <option key={fn} value={fn}>
                  {FUNCTION_LABELS[fn]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={LABEL}>
          Lead (owner)
          <input name="owner" required defaultValue={tactic.owner} className={FIELD} />
        </label>
        <label className={LABEL}>
          Why? (required)
          <textarea
            name="rationale"
            rows={2}
            placeholder="What changed and why — stored with the edit"
            className="w-full resize-none rounded-lg border border-input bg-card px-2.5 py-1.5 text-[12px] font-normal normal-case tracking-normal text-foreground"
          />
        </label>
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-popover px-4 py-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || refreshing}>
          {pending || refreshing ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {pending || refreshing ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
