"use client";

import { LockForm } from "@/components/lock-form";
import {
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
      <input type="hidden" name="description" value="Recorded as catch-up from Gaps. Not ideation." />
      <input type="hidden" name="population" value="To be specified" />
      <input type="hidden" name="intervention" value="Velmara" />
      <input type="hidden" name="comparator" value="To be specified" />
      <input type="hidden" name="outcomes" value="To be specified" />
      <input type="hidden" name="geography" value="US + EU5" />
      <input type="hidden" name="owner" value="" />
      <input type="hidden" name="function" value="evidence_lead" />
    </LockForm>
  );
}
