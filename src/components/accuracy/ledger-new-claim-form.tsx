"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ClaimFieldsForm,
  EMPTY_CLAIM_FIELDS,
  claimPatchFromValues,
  type ClaimFieldValues,
  type ClaimKind,
  type TacticOption,
} from "@/components/accuracy/claim-fields-form";
import { rationaleError, sendJson } from "@/components/accuracy/claim-api";
import { useAiEnabled } from "@/components/platform/ai-status";

/** Manual entry: create a gap or tactic by hand, no AI involved. */
export function LedgerNewClaimForm({
  workspaceId,
  tacticOptions,
  initialKind = null,
}: {
  workspaceId: string;
  tacticOptions: TacticOption[];
  /** Open the form on this claim type (e.g. `?add=gap` from the first screen). */
  initialKind?: ClaimKind | null;
}) {
  const router = useRouter();
  // With AI off there is no upload / extract: hand entry is the way in, so it leads.
  const aiOn = useAiEnabled();
  const [open, setOpen] = useState(initialKind !== null);
  const [kind, setKind] = useState<ClaimKind>(initialKind ?? "gap");
  const [values, setValues] = useState<ClaimFieldValues>(EMPTY_CLAIM_FIELDS);
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function openAs(next: ClaimKind) {
    setKind(next);
    setOpen(true);
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!values.statement.trim()) {
      setError(kind === "gap" ? "A gap statement is required." : "A tactic name is required.");
      return;
    }
    const missing = rationaleError(rationale);
    if (missing) {
      setError(missing);
      return;
    }
    const { statement, ...fields } = claimPatchFromValues(kind, values, null);
    setPending(true);
    const result = await sendJson("/api/accuracy/claims", "POST", {
      workspace_id: workspaceId,
      claim_type: kind,
      statement,
      rationale,
      fields,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const created = result.json.claim as { id?: string } | undefined;
    setMessage(`Created draft ${kind} ${created?.id ?? ""}`.trim());
    setValues(EMPTY_CLAIM_FIELDS);
    setRationale("");
    router.refresh();
  }

  return (
    <section className="mb-6 grid gap-2 border border-border bg-card/40 p-3" aria-labelledby="new-claim">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="new-claim" className="text-[13px] font-medium text-foreground">
          {aiOn ? "New claim (manual entry)" : "Add gaps and tactics"}
        </h2>
        <div className="flex flex-wrap gap-2">
          {!open ? (
            <>
              <Button size="sm" variant={aiOn ? "outline" : "default"} onClick={() => openAs("gap")}>
                Add gap
              </Button>
              <Button size="sm" variant={aiOn ? "outline" : "default"} onClick={() => openAs("tactic")}>
                Add tactic
              </Button>
            </>
          ) : (
            <Button size="sm" variant="default" onClick={() => setOpen(false)}>
              Close
            </Button>
          )}
        </div>
      </div>
      {!aiOn ? (
        <p className="text-[11px] text-muted-foreground" data-testid="new-claim-ai-off">
          AI is off, so nothing is uploaded or extracted. Type each evidence gap and each tactic
          here; every entry is a draft until you validate it below.
        </p>
      ) : null}
      {message ? <p className="text-[11px] text-[var(--known)]">{message}</p> : null}
      {open ? (
        <form onSubmit={submit} className="grid gap-2" data-testid="new-claim-form">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-[11px] text-muted-foreground">Type</legend>
            {(["gap", "tactic"] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={kind === option ? "default" : "outline"}
                onClick={() => setKind(option)}
              >
                {option === "gap" ? "Gap" : "Tactic"}
              </Button>
            ))}
          </fieldset>
          <ClaimFieldsForm
            kind={kind}
            values={values}
            onChange={setValues}
            tacticOptions={tacticOptions}
            disabled={pending}
            idPrefix="new-claim"
          />
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Rationale (required)
            <Textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={2}
              placeholder="Where this comes from / why it belongs in the plan"
              className="text-[12px]"
            />
          </label>
          {error ? (
            <p className="text-[11px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating…" : `Create draft ${kind}`}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
