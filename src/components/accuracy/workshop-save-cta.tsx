"use client";

import { requestErrorMessage, postJson, RequestOutcomeError } from "@/lib/post-json";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function WorkshopSaveCta({
  workspaceId,
  ready,
  blockers,
  hasSnapshot,
  workshopHref,
}: {
  workspaceId: string;
  ready: boolean;
  blockers: string[];
  hasSnapshot: boolean;
  workshopHref: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [checkRequired, setCheckRequired] = useState(false);

  async function save() {
    if (pending || checkRequired) return;
    setError(null);
    setPending(true);
    try {
      const res = await postJson("/api/accuracy/workshop", {
          workspace_id: workspaceId,
          note: "Save state for workshop after validate/map",
        }, { method: "POST" });
      const body = res.json as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setCheckRequired(res.outcome !== "rejected");
        setError(body.error ?? "We couldn’t confirm the workshop save. Check workshop state before saving again.");
        return;
      }
      router.push(workshopHref);
      router.refresh();
    } catch (err) {
      setCheckRequired(!(err instanceof RequestOutcomeError) || err.outcome === "unknown");
      setError(requestErrorMessage(err, "Could not save workshop state. Check the current state before trying again. If this continues, contact your Synapse administrator."));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="mb-6 border border-border bg-card p-3 rounded-lg"
      aria-labelledby="workshop-save-heading"
    >
      <h2 id="workshop-save-heading" className="text-[13px] font-semibold text-foreground">
        Workshop
      </h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        After validate/map, freeze inventory for the room. Live extract cannot shift mid-session.
        Writes still need a rationale.
      </p>
      {blockers.length > 0 ? (
        <ul className="mt-2 list-disc pl-4 text-[12px] text-muted-foreground">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--known-foreground)]">Ready to save workshop state.</p>
      )}
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!ready || pending || checkRequired} onClick={() => void save()}>
          {pending ? "Saving…" : "Save state for workshop"}
        </Button>
        {checkRequired ? <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>Check workshop state</Button> : null}
        {hasSnapshot ? (
          <Button size="sm" variant="outline" onClick={() => router.push(workshopHref)}>
            Enter workshop
          </Button>
        ) : null}
      </div>
    </section>
  );
}
