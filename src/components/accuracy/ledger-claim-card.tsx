"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ClaimFieldsForm,
  claimPatchFromValues,
  type ClaimFieldValues,
  type TacticOption,
} from "@/components/accuracy/claim-fields-form";
import { rationaleError, sendJson } from "@/components/accuracy/claim-api";

export type LedgerClaimCardModel = {
  id: string;
  claim_type: string;
  statement: string;
  status: string;
  validated: boolean;
  source_badge: string;
  validation_rationale: string | null;
  computed_status?: string | null;
  external_id?: string | null;
  chapter_label?: string | null;
  si_label?: string | null;
  /** Current values for the Edit form. */
  fields?: ClaimFieldValues;
  /** Fields a human set by hand (AI re-runs never overwrite them). */
  human_locked?: string[];
  last_edit?: { at: string; by: string; rationale: string } | null;
  status_override?: string | null;
  merge_proposal?: {
    survivor_id: string;
    survivor_statement: string | null;
    reason: string;
    rationale: string | null;
  } | null;
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

type Panel = "edit" | "merge" | null;

export function LedgerClaimCard({
  claim,
  workspaceId,
  tacticOptions = [],
  mergeTargets = [],
}: {
  claim: LedgerClaimCardModel;
  workspaceId: string;
  /** All tactics (for depends_on). */
  tacticOptions?: TacticOption[];
  /** Same-type active claims this one could be merged into. */
  mergeTargets?: TacticOption[];
}) {
  const router = useRouter();
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [values, setValues] = useState<ClaimFieldValues | null>(claim.fields ?? null);
  const [editRationale, setEditRationale] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeRationale, setMergeRationale] = useState("");
  const [proposalRationale, setProposalRationale] = useState("");
  const kind = claim.claim_type === "tactic" ? "tactic" : "gap";

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

  async function saveEdit() {
    if (!values || !claim.fields) return;
    setError(null);
    const patch = claimPatchFromValues(kind, values, claim.fields);
    if (Object.keys(patch).length === 0) {
      setError("Nothing changed.");
      return;
    }
    const missing = rationaleError(editRationale);
    if (missing) {
      setError(missing);
      return;
    }
    setPending("edit");
    const result = await sendJson("/api/accuracy/claims", "PATCH", {
      workspace_id: workspaceId,
      claim_id: claim.id,
      patch,
      rationale: editRationale,
    });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditRationale("");
    setPanel(null);
    router.refresh();
  }

  async function mergeAction(
    body: Record<string, unknown>,
    reason: string,
    reset: () => void,
    label: string,
  ) {
    setError(null);
    const missing = rationaleError(reason);
    if (missing) {
      setError(missing);
      return;
    }
    setPending(label);
    const result = await sendJson("/api/accuracy/claims/merge", "POST", {
      workspace_id: workspaceId,
      rationale: reason,
      ...body,
    });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset();
    setPanel(null);
    router.refresh();
  }

  const humanEdited = (claim.human_locked?.length ?? 0) > 0;

  return (
    <li className="border border-border bg-card/40 p-3" data-testid={`ledger-claim-${claim.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-foreground">
          {claim.external_id ? (
            <span className="mr-1.5 font-medium text-foreground">{claim.external_id}</span>
          ) : null}
          {claim.statement}
        </p>
        <span className={`shrink-0 text-[11px] ${validationTone(claim)}`}>{validationLabel(claim)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">
          {claim.source_badge}
        </Badge>
        {humanEdited ? (
          <Badge
            variant="outline"
            className="border-foreground/60 text-[10px]"
            title={`Human-locked: ${claim.human_locked?.join(", ")}`}
          >
            Human-edited · locked
          </Badge>
        ) : null}
        {claim.chapter_label ? (
          <Badge variant="secondary" className="text-[10px]">
            {claim.chapter_label}
          </Badge>
        ) : null}
        {claim.si_label ? (
          <Badge variant="secondary" className="text-[10px]">
            {claim.si_label}
          </Badge>
        ) : null}
        {!claim.chapter_label && !claim.si_label ? (
          <Badge variant="secondary" className="text-[10px]">
            {claim.claim_type}
          </Badge>
        ) : null}
        {claim.claim_type === "gap" && claim.computed_status ? (
          <Badge variant="outline" className="text-[10px]">
            {claim.status_override ? `derived ${claim.computed_status}` : claim.computed_status}
          </Badge>
        ) : null}
        {claim.claim_type === "gap" && claim.status_override ? (
          <Badge variant="default" className="text-[10px]">
            override · {claim.status_override}
          </Badge>
        ) : null}
        <span className="text-[11px] text-muted-foreground">{claim.id}</span>
      </div>
      {claim.validation_rationale ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Last rationale: {claim.validation_rationale}
        </p>
      ) : null}
      {claim.last_edit ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Last edit by {claim.last_edit.by} · {claim.last_edit.at.slice(0, 16).replace("T", " ")} —{" "}
          {claim.last_edit.rationale}
        </p>
      ) : null}

      {claim.merge_proposal ? (
        <div className="mt-3 grid gap-2 border border-dashed border-border p-2" data-testid="merge-proposal">
          <p className="text-[11px] text-foreground">
            Model proposes this duplicates{" "}
            <span className="font-medium">
              {claim.merge_proposal.survivor_statement ?? claim.merge_proposal.survivor_id}
            </span>{" "}
            <span className="text-muted-foreground">
              ({claim.merge_proposal.survivor_id} · {claim.merge_proposal.reason}
              {claim.merge_proposal.rationale ? ` · ${claim.merge_proposal.rationale}` : ""})
            </span>
            . Not applied — this claim is validated or human-edited.
          </p>
          <Textarea
            value={proposalRationale}
            onChange={(e) => setProposalRationale(e.target.value)}
            rows={2}
            placeholder="Rationale to confirm or dismiss the merge (required)"
            className="text-[12px]"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void mergeAction(
                  {
                    action: "merge",
                    survivor_id: claim.merge_proposal!.survivor_id,
                    duplicate_id: claim.id,
                  },
                  proposalRationale,
                  () => setProposalRationale(""),
                  "confirm",
                )
              }
            >
              {pending === "confirm" ? "Merging…" : "Confirm merge"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void mergeAction(
                  { action: "dismiss", claim_id: claim.id },
                  proposalRationale,
                  () => setProposalRationale(""),
                  "dismiss",
                )
              }
            >
              {pending === "dismiss" ? "Dismissing…" : "Not a duplicate"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {claim.fields ? (
          <Button
            size="sm"
            variant={panel === "edit" ? "default" : "outline"}
            disabled={pending !== null}
            onClick={() => {
              setError(null);
              setValues(claim.fields ?? null);
              setPanel(panel === "edit" ? null : "edit");
            }}
          >
            {panel === "edit" ? "Close edit" : "Edit"}
          </Button>
        ) : null}
        {mergeTargets.length > 0 ? (
          <Button
            size="sm"
            variant={panel === "merge" ? "default" : "outline"}
            disabled={pending !== null}
            onClick={() => {
              setError(null);
              setPanel(panel === "merge" ? null : "merge");
            }}
          >
            {panel === "merge" ? "Close merge" : "Merge into…"}
          </Button>
        ) : null}
      </div>

      {panel === "edit" && values ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-3" data-testid="claim-edit-form">
          <ClaimFieldsForm
            kind={kind}
            values={values}
            onChange={setValues}
            tacticOptions={tacticOptions}
            selfId={claim.id}
            disabled={pending !== null}
            idPrefix={`edit-${claim.id}`}
          />
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Edit rationale (required)
            <Textarea
              value={editRationale}
              onChange={(e) => setEditRationale(e.target.value)}
              rows={2}
              placeholder="Why this change — kept in the audit trail"
              className="text-[12px]"
            />
          </label>
          <p className="text-[10px] text-muted-foreground">
            Changed fields become human-locked: later extract / merge / status runs will not
            overwrite them.
          </p>
          <div>
            <Button size="sm" disabled={pending !== null} onClick={() => void saveEdit()}>
              {pending === "edit" ? "Saving…" : "Save edit"}
            </Button>
          </div>
        </div>
      ) : null}

      {panel === "merge" ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Merge this {kind} into (survivor)
            <select
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-[12px] text-foreground"
            >
              <option value="">Choose a claim…</option>
              {mergeTargets.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.statement.slice(0, 90)} ({row.id})
                </option>
              ))}
            </select>
          </label>
          <Textarea
            value={mergeRationale}
            onChange={(e) => setMergeRationale(e.target.value)}
            rows={2}
            placeholder="Why these are the same item (required)"
            className="text-[12px]"
          />
          <div>
            <Button
              size="sm"
              disabled={pending !== null || !mergeTarget}
              onClick={() =>
                void mergeAction(
                  { action: "merge", survivor_id: mergeTarget, duplicate_id: claim.id },
                  mergeRationale,
                  () => {
                    setMergeRationale("");
                    setMergeTarget("");
                  },
                  "merge",
                )
              }
            >
              {pending === "merge" ? "Merging…" : "Merge"}
            </Button>
          </div>
        </div>
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
      {error ? (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
