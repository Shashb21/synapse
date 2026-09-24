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

/** Manual entry: create a gap or tactic by hand, no AI involved. */
export function LedgerNewClaimForm({
  workspaceId,
  tacticOptions,
}: {
  workspaceId: string;
  tacticOptions: TacticOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ClaimKind>("gap");
  const [values, setValues] = useState<ClaimFieldValues>(EMPTY_CLAIM_FIELDS);
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
          New claim (manual entry)
        </h2>
        <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(!open)}>
          {open ? "Close" : "New claim"}
        </Button>
      </div>
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
