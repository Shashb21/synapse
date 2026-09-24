"use client";

import { LockForm } from "@/components/lock-form";
import {
  ACTOR_FUNCTIONS,
  FUNCTION_LABELS,
  CATCH_UP_REASON_LABELS,
  CATCH_UP_REASONS,
  CATCH_UP_TACTIC_STATUSES,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";
import type { TacticLibraryItem } from "@/lib/iegp/engine";

export const GAPS_TACTIC_HELPER =
  "Map tactics already in the library, or record one ingest missed or that you remember from a source not yet uploaded. Do not invent new studies here — that happens on Tactics after you prioritize.";

function tacticOptionLabel(tactic: TacticLibraryItem) {
  if (tactic.gaps.length === 0) return `${tactic.name} · not tagged yet`;
  if (tactic.gaps.length === 1) return `${tactic.name} · 1 gap`;
  return `${tactic.name} · ${tactic.gaps.length} gaps`;
}

export function RecordMissedFields({ prefix = false }: { prefix?: boolean }) {
  const name = prefix ? "tactic_name" : "name";
  const type = prefix ? "tactic_type" : "type";
  const status = prefix ? "tactic_status" : "status";
  const question = prefix ? "tactic_evidence_question" : "evidence_question";
  return (
    <>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Tactic name
        <input
          name={name}
          required={!prefix}
          placeholder="Study, programme, or publication name"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Type
        <select
          name={type}
          required={!prefix}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {TACTIC_TYPES.map((row) => (
            <option key={row} value={row}>
              {TACTIC_TYPE_LABELS[row]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Status
        <select
          name={status}
          required={!prefix}
          defaultValue="ongoing"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {CATCH_UP_TACTIC_STATUSES.map((row) => (
            <option key={row} value={row}>
              {row}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Evidence question
        <input
          name={question}
          required={!prefix}
          placeholder="What question does this study answer?"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Why this was missed (optional)
        <select
          name="catch_up_reason"
          defaultValue=""
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="">Skip</option>
          {CATCH_UP_REASONS.map((row) => (
            <option key={row} value={row}>
              {CATCH_UP_REASON_LABELS[row]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

const DETAIL_FIELDS: { name: string; label: string; placeholder: string }[] = [
  { name: "population", label: "Population", placeholder: "e.g. adults with EGFR+ NSCLC after 1L" },
  { name: "intervention", label: "Intervention", placeholder: "e.g. the asset, dose or regimen" },
  { name: "comparator", label: "Comparator", placeholder: "e.g. standard of care" },
  { name: "outcomes", label: "Outcomes", placeholder: "e.g. OS, PFS, HCRU" },
  { name: "study_design", label: "Study design", placeholder: "e.g. retrospective cohort" },
  { name: "data_source", label: "Data source", placeholder: "e.g. Flatiron EHR, sponsor registry" },
  { name: "geography", label: "Geography", placeholder: "e.g. US, EU5" },
  { name: "owner", label: "Owner", placeholder: "Blank: you" },
];

/**
 * The tactic's descriptive fields, all optional and empty until a person fills
 * them. Nothing is prefilled: a blank field is stored blank.
 */
export function TacticDetailFields() {
  return (
    <details className="grid gap-2">
      <summary className="cursor-pointer text-[12px] text-muted-foreground">
        Details (optional — population, design, data source, geography, owner)
      </summary>
      <div className="mt-2 grid gap-2">
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Description
          <textarea
            name="description"
            placeholder="Blank: the name is used"
            className="min-h-14 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </label>
        {DETAIL_FIELDS.map((field) => (
          <label key={field.name} className="grid gap-1 text-[12px] text-muted-foreground">
            {field.label}
            <input
              name={field.name}
              placeholder={field.placeholder}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
          </label>
        ))}
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Owner function
          <select
            name="function"
            defaultValue="evidence_lead"
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {ACTOR_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {FUNCTION_LABELS[fn]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  );
}

export function MapExistingTactic({
  gapId,
  availableTactics,
  mappedTacticIds,
}: {
  gapId: string;
  availableTactics: TacticLibraryItem[];
  mappedTacticIds: string[];
}) {
  const unmapped = availableTactics.filter((tactic) => !mappedTacticIds.includes(tactic.id));
  if (unmapped.length === 0) return null;
  return (
    <LockForm
      label="Map existing tactic"
      action="assign_tactic"
      extra={{ gap_id: gapId }}
      confirmLabel="Map tactic"
      description="Attach a library tactic onto this gap. The tactic is not copied."
    >
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        From tactic library
        <select
          name="tactic_id"
          required
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        >
          {unmapped.map((tactic) => (
            <option key={tactic.id} value={tactic.id}>
              {tacticOptionLabel(tactic)}
            </option>
          ))}
        </select>
      </label>
    </LockForm>
  );
}

export function RecordMissedTactic({ gapId }: { gapId: string }) {
  return (
    <LockForm
      label="Record missed tactic"
      action="record_missed_tactic"
      extra={{ gap_id: gapId, origin: "gaps" }}
      confirmLabel="Record and map"
      description="Catch-up only. Record a real study ingest missed, a source not yet uploaded, or one you remember. Do not invent new studies here."
    >
      <RecordMissedFields />
      <TacticDetailFields />
    </LockForm>
  );
}
