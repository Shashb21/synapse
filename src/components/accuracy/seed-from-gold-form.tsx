"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const PACKS = [
  { id: "beone-bgb-58067-prmt5i", label: "BGB-58067 PRMT5i IEP" },
  { id: "beone-tislelizumab-iegp", label: "Tislelizumab IEGP" },
] as const;

export function SeedFromGoldForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [packId, setPackId] = useState<string>(PACKS[0].id);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSummary(null);
    startTransition(async () => {
      const res = await fetch("/api/accuracy/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pack_id: packId, parse_source: true }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        workspace_id?: string;
        gaps?: number;
        tactics?: number;
        parse_blocks?: number;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.workspace_id) {
        setError(body.error ?? "Seed failed");
        return;
      }
      setSummary(
        `Seeded ${body.gaps ?? 0} gaps, ${body.tactics ?? 0} tactics, ${body.parse_blocks ?? 0} parse blocks`,
      );
      router.push(`/accuracy/ledger?workspace_id=${encodeURIComponent(body.workspace_id)}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 border border-border bg-card/40 p-3">
      <h3 className="text-[13px] font-medium text-foreground">Seed from BeOne reference gold</h3>
      <p className="text-[12px] text-muted-foreground">
        Creates a workspace, loads gold gap/tactic statements, and has the parse route&apos;s LLM
        parse the reference source when present.
      </p>
      <label className="grid gap-1 text-[12px]">
        <span className="text-muted-foreground">Reference pack</span>
        <select
          className="border border-border bg-background px-2 py-1.5 text-[13px]"
          value={packId}
          onChange={(e) => setPackId(e.target.value)}
        >
          {PACKS.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.label}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      {summary ? <p className="text-[12px] text-muted-foreground">{summary}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[12px] text-background disabled:opacity-50"
      >
        {pending ? "Seeding…" : "Seed workspace from gold"}
      </button>
    </form>
  );
}
