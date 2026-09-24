import { LockForm } from "@/components/lock-form";
import {
  ASSESSED_COVERAGE,
  COVERAGE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_VALUES,
  OVERALL_COVERAGE_LABELS,
} from "@/lib/iegp/enums";
import type { TacticLibraryItem } from "@/lib/iegp/engine";

const SELECT = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground";

/**
 * Manual create: a person maps a library tactic onto this gap and records the
 * coverage verdict (overall and any dimension) in the same step, with no model.
 * The verdict is the person's and is locked; S4 never rewrites it.
 */
export function AssignTacticWithCoverage({
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
      label="Map tactic with coverage"
      action="assign_tactic"
      extra={{ gap_id: gapId }}
      confirmLabel="Map and record coverage"
      description="Map a library tactic and record your own coverage verdict. Leave a dimension blank to keep it unknown."
    >
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Tactic
        <select name="tactic_id" required className={SELECT}>
          {unmapped.map((tactic) => (
            <option key={tactic.id} value={tactic.id}>
              {tactic.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Overall coverage
        <select name="overall" required defaultValue="" className={SELECT}>
          <option value="" disabled>
            Choose a verdict
          </option>
          {ASSESSED_COVERAGE.map((value) => (
            <option key={value} value={value}>
              {OVERALL_COVERAGE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 text-[12px] text-muted-foreground">Dimensions (optional)</legend>
        {COVERAGE_DIMENSIONS.map((dim) => (
          <label key={dim} className="grid gap-1 text-[11px] text-muted-foreground">
            {DIMENSION_LABELS[dim]}
            <select name={`dim_${dim}`} defaultValue="" className={SELECT}>
              <option value="">unknown</option>
              {DIMENSION_VALUES.filter((value) => value !== "unknown").map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Rationale (required)
        <textarea
          name="rationale"
          required
          minLength={3}
          placeholder="Why this tactic covers the gap this much"
          className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
        />
      </label>
    </LockForm>
  );
}

/** Removes a mapping. The pair is recorded as rejected so S4 never maps it again. */
export function UnassignTactic({ gapId, tacticId }: { gapId: string; tacticId: string }) {
  return (
    <LockForm
      label="Remove mapping"
      action="unassign_tactic"
      extra={{ gap_id: gapId, tactic_id: tacticId }}
      confirmLabel="Remove mapping"
      description="Unmaps this tactic from this gap and records it as rejected, so a later S4 run does not map it again. You can map it again by hand."
    >
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Rationale (required)
        <textarea
          name="rationale"
          required
          minLength={3}
          placeholder="Why this tactic does not belong on this gap"
          className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
        />
      </label>
    </LockForm>
  );
}
