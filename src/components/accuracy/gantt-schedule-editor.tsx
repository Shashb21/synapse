"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ClaimScheduleFields,
  EMPTY_CLAIM_FIELDS,
  claimPatchFromValues,
  type ClaimFieldValues,
  type TacticOption,
} from "@/components/accuracy/claim-fields-form";
import { rationaleError, sendJson } from "@/components/accuracy/claim-api";

export type GanttTacticSchedule = {
  id: string;
  statement: string;
  validated: boolean;
  /** Stored (human or sourced) values — not the continuity-shifted projection. */
  start: string;
  end: string;
  readout: string;
  depends_on: string[];
  /** Human-entered dates are pinned against re-projection. */
  dates_locked: boolean;
};

function toValues(row: GanttTacticSchedule): ClaimFieldValues {
  return {
    ...EMPTY_CLAIM_FIELDS,
    statement: row.statement,
    start: row.start,
    end: row.end,
    readout: row.readout,
    depends_on: row.depends_on,
  };
}

/** Edit start / end / readout / depends_on for one tactic (PATCH /api/accuracy/claims). */
export function GanttScheduleEditor({
  workspaceId,
  tactic,
  tacticOptions,
}: {
  workspaceId: string;
  tactic: GanttTacticSchedule;
  tacticOptions: TacticOption[];
}) {
  const router = useRouter();
  const initial = toValues(tactic);
  const [values, setValues] = useState<ClaimFieldValues>(initial);
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setError(null);
    setMessage(null);
    const full = claimPatchFromValues("tactic", values, initial);
    const patch: Record<string, unknown> = {};
    for (const key of ["start", "end", "readout", "depends_on"]) {
      if (key in full) patch[key] = full[key];
    }
    if (Object.keys(patch).length === 0) {
      setError("Nothing changed.");
      return;
    }
    const missing = rationaleError(rationale);
    if (missing) {
      setError(missing);
      return;
    }
    setPending(true);
    const result = await sendJson("/api/accuracy/claims", "PATCH", {
      workspace_id: workspaceId,
      claim_id: tactic.id,
      patch,
      rationale,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRationale("");
    setMessage("Schedule saved — human dates are pinned on re-projection.");
    router.refresh();
  }

  return (
    <div className="grid gap-2" data-testid={`gantt-schedule-${tactic.id}`}>
      <ClaimScheduleFields
        values={values}
        onChange={setValues}
        tacticOptions={tacticOptions.filter((row) => row.id !== tactic.id)}
        disabled={pending}
        idPrefix={`gantt-${tactic.id}`}
      />
      <Textarea
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        rows={2}
        placeholder="Why these dates / dependencies (required)"
        className="text-[12px]"
      />
      {tactic.dates_locked ? (
        <p className="text-[10px] text-muted-foreground">
          Dates are human-entered and pinned (continuity does not shift them).
        </p>
      ) : null}
      {error ? (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-[11px] text-[var(--known)]">{message}</p> : null}
      <div>
        <Button size="sm" disabled={pending} onClick={() => void save()}>
          {pending ? "Saving…" : "Save schedule"}
        </Button>
      </div>
    </div>
  );
}
