"use client";

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

  async function save() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/accuracy/workshop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          note: "Save state for workshop after validate/map",
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not save workshop state");
        return;
      }
      router.push(workshopHref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save workshop state");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="mb-6 border border-border bg-card/40 p-3"
      aria-labelledby="workshop-save-heading"
    >
      <h2 id="workshop-save-heading" className="text-[15px] font-medium text-foreground">
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
        <p className="mt-2 text-[12px] text-[var(--known)]">Ready to save workshop state.</p>
      )}
      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!ready || pending} onClick={() => void save()}>
          {pending ? "Saving…" : "Save state for workshop"}
        </Button>
        {hasSnapshot ? (
          <Button size="sm" variant="outline" onClick={() => router.push(workshopHref)}>
            Enter workshop
          </Button>
        ) : null}
      </div>
    </section>
  );
}
