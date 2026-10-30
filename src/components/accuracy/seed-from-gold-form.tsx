"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useAiEnabled } from "@/components/platform/ai-status";
import { postJson } from "@/lib/post-json";

const PACKS = [
  { id: "beone-bgb-58067-prmt5i", label: "BGB-58067 PRMT5i IEP" },
  { id: "beone-tislelizumab-iegp", label: "Tislelizumab IEGP" },
] as const;

export function SeedFromGoldForm() {
  const router = useRouter();
  const aiOn = useAiEnabled();
  const [pending, startTransition] = useTransition();
  const [packId, setPackId] = useState<string>(PACKS[0].id);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [checkRequired, setCheckRequired] = useState(false);
  const [seededHref, setSeededHref] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || checkRequired || seededHref) return;
    setError(null);
    setSummary(null);
    startTransition(async () => {
      const res = await postJson("/api/accuracy/seed", { pack_id: packId, parse_source: aiOn });
      const body = res.json as {
        ok?: boolean;
        workspace_id?: string;
        gaps?: number;
        tactics?: number;
        parse_blocks?: number;
        parse_skipped?: string | null;
        parse_error?: string | null;
        error?: string;
      };
      const validSuccess = body.ok === true && typeof body.workspace_id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(body.workspace_id)
        && [body.gaps, body.tactics, body.parse_blocks].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
      if (!res.ok || !validSuccess) {
        const unknown = res.ok || res.outcome === "unknown";
        setCheckRequired(unknown);
        // Only failed responses have had their error text checked by postJson.
        setError(unknown
          ? [!res.ok ? body.error : null, "We couldn’t confirm creation of the example workspace. Check the workspace list before seeding it again."].filter(Boolean).join(" ")
          : body.error ?? "We couldn’t create the example workspace. Check the reference pack before trying again.");
        return;
      }
      const href = `/admin/accuracy/ledger?workspace_id=${encodeURIComponent(body.workspace_id!)}`;
      if (body.parse_error) {
        setSummary(`Seeded ${body.gaps} gaps and ${body.tactics} tactics. Reading the reference source did not finish. Open the seeded workspace and review its source text blocks before adding missing content by hand.`);
        setSeededHref(href);
        return;
      }
      setSummary(
        body.parse_skipped
          ? `Seeded ${body.gaps ?? 0} gaps and ${body.tactics ?? 0} tactics. ${body.parse_skipped}`
          : `Seeded ${body.gaps ?? 0} gaps, ${body.tactics ?? 0} tactics, ${body.parse_blocks ?? 0} parse blocks`,
      );
      router.push(href);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 border border-border bg-card p-3 rounded-lg">
      <h3 className="text-[12px] font-semibold text-foreground">Seed from BeOne reference gold</h3>
      <p className="text-[12px] text-muted-foreground">
        {aiOn
          ? "Creates a workspace, loads gold gap/tactic statements, and has the parse route’s LLM parse the reference source when present."
          : "Creates a workspace and loads the gold gap/tactic statements as drafts to review by hand. AI is off, so the reference source is not parsed."}
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
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {summary ? <p role="status" className="text-sm text-muted-foreground">{summary}</p> : null}
      {seededHref ? <Link href={seededHref}>Open seeded workspace</Link> : null}
      {checkRequired ? <button type="button" onClick={() => window.location.reload()}>Check workspace list</button> : null}
      <button
        type="submit"
        disabled={pending || checkRequired || seededHref !== null}
        className="w-fit border border-foreground bg-foreground px-3 py-1.5 text-[12px] text-background disabled:opacity-50"
      >
        {pending ? "Seeding…" : "Seed workspace from gold"}
      </button>
    </form>
  );
}
