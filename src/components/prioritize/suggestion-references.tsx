"use client";

import { requestErrorMessage, RequestOutcomeError } from "@/lib/post-json";

import { useState } from "react";
import Link from "next/link";
import type { InspectableReference, JudgementReference } from "@/lib/iegp/judgement-references";

export function SuggestionReferences({ gapId, version, references }: { gapId: string; version: string | null; references?: JudgementReference[] }) {
  const [records, setRecords] = useState<InspectableReference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function inspect() {
    setPending(true);
    setError(null);
    setRecords(null);
    try {
      const response = await fetch(`/api/plan/references?gap_id=${encodeURIComponent(gapId)}`);
      if (!response.ok) throw new Error("Supporting references could not be loaded. Try again.");
      const body = await response.json();
      if (!version || body.version !== version) throw new RequestOutcomeError("This suggestion changed. Refresh the page and inspect the current suggestion before making a judgement.", "rejected", 409);
      if (!body.references?.length) throw new RequestOutcomeError("Supporting references are unavailable or no longer related. Regenerate the suggestion or make a manual judgement.", "rejected", 409);
      setRecords(body.references);
    } catch (failure) {
      setError(requestErrorMessage(failure, "Supporting references could not be loaded. Try again."));
    } finally { setPending(false); }
  }
  if (!references?.length) return <p className="text-[12px] text-muted-foreground">Supporting references not recorded for this suggestion</p>;
  return <div className="grid gap-2 text-[12px]">
    <button type="button" onClick={() => void inspect()} disabled={pending} className="justify-self-start underline">{pending ? "Loading supporting references…" : "Inspect supporting references"}</button>
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    {records ? <ul className="grid gap-2">{records.map((reference, index) => <li key={`${reference.entity_type}-${reference.entity_id}-${index}`} className="break-words border border-border p-2">
      <Link href={reference.href}>{reference.title}</Link>
      <p className="whitespace-pre-wrap">{reference.excerpt}</p>
      <p>Supports: {reference.reason}</p>
    </li>)}</ul> : null}
  </div>;
}
