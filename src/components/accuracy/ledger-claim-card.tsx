"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type LedgerClaimCardModel = {
  id: string;
  claim_type: string;
  statement: string;
  status: string;
  validated: boolean;
  source_badge: string;
  validation_rationale: string | null;
  computed_status?: string | null;
};

function validationLabel(claim: LedgerClaimCardModel): string {
  if (claim.validated) return "Validated";
  if (claim.status === "rejected") return "Rejected";
  return "Draft";
}

function validationTone(claim: LedgerClaimCardModel): string {
  if (claim.validated) return "text-[var(--known)]";
  if (claim.status === "rejected") return "text-destructive";
  return "text-[var(--unknown)]";
}

export function LedgerClaimCard({
  claim,
  workspaceId,
}: {
  claim: LedgerClaimCardModel;
  workspaceId: string;
}) {
  const router = useRouter();
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState<"validate" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "validate" | "reject") {
    setError(null);
    if (rationale.trim().length < 3) {
      setError("A short rationale is required (hillclimb).");
      return;
    }
    setPending(action);
    try {
      const res = await fetch("/api/accuracy/claims/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          claim_ids: [claim.id],
          action,
          rationale,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Validation failed");
        return;
      }
      setRationale("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <li className="border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-foreground">{claim.statement}</p>
        <span className={`shrink-0 text-[11px] ${validationTone(claim)}`}>{validationLabel(claim)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">
          {claim.source_badge}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {claim.claim_type}
        </Badge>
        {claim.claim_type === "gap" && claim.computed_status ? (
          <Badge variant="outline" className="text-[10px]">
            {claim.computed_status}
          </Badge>
        ) : null}
        <span className="text-[11px] text-muted-foreground">{claim.id}</span>
      </div>
      {claim.validation_rationale ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Last rationale: {claim.validation_rationale}
        </p>
      ) : null}
      {!claim.validated || claim.status === "rejected" ? (
        <div className="mt-3 grid gap-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Rationale (required)
            <Textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              rows={2}
              placeholder="Why validate or reject this claim"
              className="text-[12px]"
            />
          </label>
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="default"
              disabled={pending !== null}
              onClick={() => void act("validate")}
            >
              {pending === "validate" ? "Validating…" : "Validate"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void act("reject")}
            >
              {pending === "reject" ? "Rejecting…" : "Reject"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Re-validate / reject with rationale
            <Textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              rows={2}
              placeholder="Why change this decision"
              className="text-[12px]"
            />
          </label>
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void act("reject")}
            >
              Reject
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
