"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { rationaleError, sendJson } from "@/components/accuracy/claim-api";

export type MergedClaimModel = {
  id: string;
  claim_type: string;
  statement: string;
  merged_into: string | null;
  merged_into_statement: string | null;
  merge_reason: string | null;
};

function MergedRow({ row, workspaceId }: { row: MergedClaimModel; workspaceId: string }) {
  const router = useRouter();
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unmerge() {
    setError(null);
    const missing = rationaleError(rationale);
    if (missing) {
      setError(missing);
      return;
    }
    setPending(true);
    const result = await sendJson("/api/accuracy/claims/merge", "POST", {
      action: "unmerge",
      workspace_id: workspaceId,
      claim_id: row.id,
      rationale,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRationale("");
    router.refresh();
  }

  return (
    <li className="border border-border bg-card/40 p-3" data-testid={`merged-claim-${row.id}`}>
      <p className="text-[12px] text-foreground">{row.statement}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {row.claim_type} {row.id} · merged into{" "}
        {row.merged_into_statement ? `“${row.merged_into_statement.slice(0, 90)}” ` : ""}
        {row.merged_into ?? "?"}
        {row.merge_reason ? ` · ${row.merge_reason}` : ""}
      </p>
      <div className="mt-2 grid gap-2">
        <Textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={2}
          placeholder="Why these are not the same item (required to unmerge)"
          className="text-[12px]"
        />
        {error ? (
          <p className="text-[11px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void unmerge()}>
            {pending ? "Unmerging…" : "Unmerge"}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Merged-away duplicates, each with an Unmerge control (the pair is then never auto-merged again). */
export function LedgerMergedList({
  workspaceId,
  rows,
}: {
  workspaceId: string;
  rows: MergedClaimModel[];
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <section className="mt-8 grid gap-2" aria-labelledby="merged-section">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="merged-section" className="text-[15px] font-medium text-foreground">
          Merged duplicates ({rows.length})
        </h2>
        <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open ? (
        <ul className="grid gap-2">
          {rows.map((row) => (
            <MergedRow key={row.id} row={row} workspaceId={workspaceId} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
