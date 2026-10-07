"use client";

/** On-demand immutable generated and human versions with contributor identity review in the ledger. */
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { ItemHistory, ItemRelationship } from "@/accuracy/domain/item-history";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const relationshipLabels = { same_item: "Same item", split: "Split", merge: "Merge" };

/** Render history without selecting an alternative or changing downstream eligibility. */
export function ClaimHistory({ workspaceId, claimId }: { workspaceId: string; claimId: string }) {
  const router = useRouter();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<{ history: ItemHistory; can_decide: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId, claim_id: claimId });
      const response = await fetch(`/api/accuracy/claims/history?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load item history");
      setData(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load item history");
    } finally { setLoading(false); }
  }

  async function decide(relationship: ItemRelationship, action: "confirm" | "reject" | "propose") {
    const rationale = reasons[relationship.id]?.trim() ?? "";
    if (rationale.length < 3) { setError("A reason of at least three characters is required."); return; }
    setPending(relationship.id);
    setError(null);
    try {
      const operation = action === "propose"
        ? { action, kind: relationship.kind, predecessor_ids: relationship.predecessor_ids, successor_ids: relationship.successor_ids }
        : { action, proposal_id: relationship.id };
      const response = await fetch("/api/accuracy/claims/relationships", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, ...operation, rationale }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not review relationship");
      setReasons(current => ({ ...current, [relationship.id]: "" }));
      setData(null);
      await load();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not review relationship");
    } finally { setPending(null); }
  }

  return <div className="mt-3 text-[12px]">
    <Button size="sm" variant="outline" aria-expanded={expanded} aria-controls={panelId}
      onClick={() => { setExpanded(!expanded); if (!expanded && !data && !loading) void load(); }}>Item history</Button>
    {expanded ? <div id={panelId} className="mt-2 grid gap-3 border-t border-border pt-3">
      {loading ? <p role="status">Loading item history…</p> : null}
      {error ? <div><p role="alert" className="text-destructive">{error}</p><Button size="sm" variant="outline" disabled={loading || pending !== null} onClick={() => void load()}>Retry history</Button></div> : null}
      {data ? <>
        <p className="text-muted-foreground">Canonical claim: {data.history.canonical_claim_id}</p>
        {data.history.versions.length === 0 ? <p>No recorded generated versions. Legacy claims have no fabricated history.</p> :
          <ol className="grid gap-3">{data.history.versions.map(version => <li key={version.id} className="border-b border-border pb-3">
            <p className="font-medium">Version: {version.id}</p>
            <dl className="grid gap-1 text-muted-foreground">
              <div><dt className="inline">Original claim: </dt><dd className="inline">{version.claim_id}</dd></div>
              <div><dt className="inline">Source: </dt><dd className="inline">{version.source_file_id}</dd></div>
              {version.human_origin ? <>
                <div><dt className="inline">Human contributor: </dt><dd className="inline">{version.human_origin.actor.name} ({version.human_origin.actor.function})</dd></div>
                <div><dt className="inline">Change: </dt><dd className="inline">{version.human_origin.action} · {version.human_origin.reason}</dd></div>
                <div><dt className="inline">Revision: </dt><dd className="inline">{version.human_origin.revision_id}</dd></div>
                <div><dt className="inline">Parent proposal: </dt><dd className="inline">{version.human_origin.parent_assembly_id}</dd></div>
                <div><dt className="inline">Predecessor version: </dt><dd className="inline">{version.human_origin.predecessor_version_id ?? "New addition"}</dd></div>
              </> : <>
                <div><dt className="inline">Run: </dt><dd className="inline">{version.run_id}</dd></div>
                <div><dt className="inline">Snapshot: </dt><dd className="inline">{version.snapshot_id ?? "Judged final output (no snapshot)"}</dd></div>
                <div><dt className="inline">Iteration: </dt><dd className="inline">{version.iteration ?? "Judged final output"}</dd></div>
              </>}
              <div><dt className="inline">Item index: </dt><dd className="inline">{version.item_index}</dd></div>
              <div><dt className="inline">Recorded: </dt><dd className="inline">{version.created_at}</dd></div>
            </dl>
            <dl className="mt-2 grid gap-1">{Object.entries(version.payload).map(([field, value]) => <div key={field}>
              <dt className="font-medium">{field}</dt><dd className="whitespace-pre-wrap break-words">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd>
            </div>)}</dl>
            <details className="mt-2"><summary>Exact stored payload</summary><pre className="overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(version.payload, null, 2)}</pre></details>
          </li>)}</ol>}
        <p className="font-medium">Identity and ancestry</p>
        {data.history.relationships.length === 0 ? <p>No recorded relationships.</p> :
          <ul className="grid gap-3">{data.history.relationships.map(relationship => <li key={relationship.id} className="border-b border-border pb-3">
            <p className="font-medium">{relationshipLabels[relationship.kind]} · {relationship.decision === "confirm" ? "Confirmed" : relationship.decision === "reject" ? "Rejected" : relationship.stale ? "Stale proposal" : "Pending review"}</p>
            <p>Predecessors: {relationship.predecessor_ids.join(", ")}</p><p>Successors: {relationship.successor_ids.join(", ")}</p>
            <p>Proposal: {relationship.rationale}</p>
            {relationship.proposal_actor ? <p>Proposed by: {relationship.proposal_actor.name} ({relationship.proposal_actor.function})</p> : null}
            {relationship.decision_actor ? <p>Decision by: {relationship.decision_actor.name} ({relationship.decision_actor.function})</p> : null}
            {relationship.decision_rationale ? <p>Decision reason: {relationship.decision_rationale}</p> : null}
            {relationship.stale && !relationship.decision ? <p className="text-muted-foreground">Versions changed since this proposal. Review the latest content and propose a fresh relationship.</p> : null}
            {data.can_decide && !relationship.decision ? <div className="mt-2 grid gap-2">
              <label className="grid gap-1">Relationship reason (required)<Textarea rows={2} value={reasons[relationship.id] ?? ""} onChange={event => setReasons(current => ({ ...current, [relationship.id]: event.target.value }))} /></label>
              <div className="flex flex-wrap gap-2">
                {relationship.stale ? <Button size="sm" variant="outline" disabled={pending !== null || loading} onClick={() => void decide(relationship, "propose")}>Propose fresh relationship</Button> : <>
                  <Button size="sm" variant="outline" disabled={pending !== null || loading} onClick={() => void decide(relationship, "confirm")}>Confirm identity</Button>
                  <Button size="sm" variant="outline" disabled={pending !== null || loading} onClick={() => void decide(relationship, "reject")}>Reject relationship</Button>
                </>}
                {pending === relationship.id ? <span role="status">Saving relationship…</span> : null}
              </div>
            </div> : null}
          </li>)}</ul>}
      </> : null}
    </div> : null}
  </div>;
}
