"use client";

/** Deliberate parent-scope library linking with a read-only fit preview and recoverable saves. */
import { useRef, useState } from "react";
import { LockForm } from "@/components/lock-form";
import { TacticFitSelect } from "@/components/tactic-fit-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { usePageRefresh } from "@/components/platform/use-page-refresh";
import { postJson } from "@/lib/post-json";
import { ASSESSED_COVERAGE, COVERAGE_DIMENSIONS, DIMENSION_LABELS, DIMENSION_VALUES, OVERALL_COVERAGE_LABELS } from "@/lib/iegp/enums";
import type { RelationshipFitModel, TacticLibraryItem } from "@/lib/iegp/engine";

const SELECT = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground";

/** Reuse a library tactic; an assessment is submitted only through its explicit save action. */
export function AssignTacticWithCoverage({ gapId, availableTactics, mappedTacticIds, requirementBasisVersion, previews, expectedRelationships, label = "Map tactic with coverage" }: {
  gapId: string;
  requirementBasisVersion?: string;
  previews?: Record<string, RelationshipFitModel>;
  availableTactics: TacticLibraryItem[];
  mappedTacticIds: string[];
  label?: string;
  expectedRelationships: string;
}) {
  const unmapped = availableTactics.filter(tactic => !mappedTacticIds.includes(tactic.id));
  const [open, setOpen] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const verdictRef = useRef<HTMLSelectElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);
  const requestRef = useRef<{ payload: string; id: string } | null>(null);
  const { refreshing, refresh } = usePageRefresh();
  if (!unmapped.length) return null;

  async function save(mode: "unassessed" | "assessed") {
    if (inFlight.current || refreshing || !formRef.current) return;
    const form = formRef.current;
    const values = new FormData(form);
    const rationale = String(values.get("rationale") ?? "").trim();
    if (rationale.length < 3) {
      setError("Enter a rationale of at least three characters.");
      (form.elements.namedItem("rationale") as HTMLTextAreaElement).focus();
      return;
    }
    if (mode === "assessed") {
      const overall = form.elements.namedItem("overall") as HTMLSelectElement;
      const rationale = form.elements.namedItem("rationale") as HTMLTextAreaElement;
      if (!overall.value || rationale.value.trim().length < 3) {
        setError(!overall.value ? "Choose an overall coverage verdict." : "Enter a rationale of at least three characters.");
        (!overall.value ? overall : rationale).focus();
        return;
      }
    }
    const tacticId = String(values.get("tactic_id"));
    const basisVersion = requirementBasisVersion ?? previews?.[tacticId]?.requirement_basis_version;
    const payload: Record<string, string> = { action: "assign_tactic", gap_id: gapId, tactic_id: tacticId, link_mode: mode, rationale, expected_relationship: (JSON.parse(expectedRelationships) as Record<string, string>)[tacticId] ?? "" };
    if (mode === "assessed") {
      payload.overall = String(values.get("overall"));
      payload.rationale = String(values.get("rationale"));
      if (basisVersion) payload.expected_basis_version = basisVersion;
      const designVersion = previews?.[tacticId]?.design_version;
      if (designVersion) payload.expected_design_version = designVersion;
      for (const dimension of COVERAGE_DIMENSIONS) {
        const value = values.get(`dim_${dimension}`);
        if (value) payload[`dim_${dimension}`] = String(value);
      }
    }
    // Keep the same request ID if a successful response was lost in transit.
    const serialized = JSON.stringify(payload);
    if (requestRef.current?.payload !== serialized) requestRef.current = { payload: serialized, id: crypto.randomUUID() };
    inFlight.current = true;
    setPending(true);
    setError(null);
    const result = await postJson("/api/iegp", { ...payload, request_id: requestRef.current.id });
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.json.error ?? "Could not save. Your inputs are retained; try again.");
      // Move focus to the announced error after React renders it, retaining every control value.
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    refresh(() => setOpen(false));
  }

  return (
    <Dialog open={open} onOpenChange={next => {
      if (inFlight.current || refreshing) return;
      setOpen(next);
      if (next) { setError(null); setAssessing(false); requestRef.current = null; }
    }}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>{label}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!pending && !refreshing}>
        <form ref={formRef} noValidate onSubmit={event => { event.preventDefault(); void save("assessed"); }}>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>Preview fit to this gap. Reuse the library tactic, then choose how to link it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3">
            <fieldset disabled={pending || refreshing} className="grid min-w-0 gap-3">
              <TacticFitSelect tactics={unmapped} previews={previews} />
              <p className="text-xs text-muted-foreground">Link as unassessed keeps coverage unknown, including when the requirement basis is unresolved.</p>
              {assessing ? <>
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Overall coverage
                  <select aria-label="Overall coverage" ref={verdictRef} name="overall" required defaultValue="" className={SELECT}>
                    <option value="" disabled>Choose a verdict</option>
                    {ASSESSED_COVERAGE.map(value => <option key={value} value={value}>{OVERALL_COVERAGE_LABELS[value]}</option>)}
                  </select>
                </label>
                <p className="text-xs text-muted-foreground">Confirming overall coverage does not confirm individual dimensions. Full confirmation needs a reviewed basis and Yes for every required dimension.</p>
                <fieldset className="grid grid-cols-2 gap-2">
                  <legend className="mb-1 text-[12px] text-muted-foreground">Dimensions (optional)</legend>
                  {COVERAGE_DIMENSIONS.map(dimension => <label key={dimension} className="grid gap-1 text-[11px] text-muted-foreground">
                    {DIMENSION_LABELS[dimension]}
                    <select aria-label={DIMENSION_LABELS[dimension]} name={`dim_${dimension}`} defaultValue="" className={SELECT}>
                      <option value="">unknown</option>
                      {DIMENSION_VALUES.filter(value => value !== "unknown").map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>)}
                </fieldset>
              </> : null}
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                Rationale (required)
                <textarea name="rationale" required minLength={3} placeholder={assessing ? "Why this tactic covers the gap this much" : "Why this tactic should be linked for later assessment"} className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm" />
              </label>
            </fieldset>
            {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive">{error}</p> : null}
            {pending || refreshing ? <p role="status">{refreshing ? "Updating…" : "Saving…"}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" disabled={pending || refreshing} />}>Cancel</DialogClose>
            <Button type="button" variant="outline" disabled={pending || refreshing} onClick={() => void save("unassessed")}>Link as unassessed</Button>
            <Button type="button" disabled={pending || refreshing} onClick={() => {
              if (assessing) { void save("assessed"); return; }
              setAssessing(true);
              requestAnimationFrame(() => verdictRef.current?.focus());
            }}>Assess and link</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Removes a mapping. The pair is recorded as rejected so S4 never maps it again. */
export function UnassignTactic({ gapId, tacticId, expectedRelationship }: { gapId: string; tacticId: string; expectedRelationship: string }) {
  return (
    <LockForm
      label="Remove mapping"
      action="unassign_tactic"
      extra={{ gap_id: gapId, tactic_id: tacticId, expected_relationship: expectedRelationship }}
      confirmLabel="Remove mapping"
      description="Unmaps this tactic from this gap and records it as rejected, so a later AI mapping run does not map it again. You can map it again by hand."
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
