"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { GapMetadata } from "@/lib/iegp/types";
import { cn } from "@/lib/utils";

export function hasGapMetadata(metadata: GapMetadata) {
  return Boolean(
    metadata.stakeholders.length || metadata.geography || metadata.regional_nuances || metadata.notes,
  );
}

/** Impacted stakeholders, geography, regional nuances and notes, read-only (KAN-49). */
export function GapMetadataView({
  metadata,
  compact = false,
  className,
}: {
  metadata: GapMetadata;
  /** One line: stakeholders · geography, as on the Tactic Ideation card. */
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    const parts = [metadata.stakeholders.join(" · "), metadata.geography].filter(Boolean);
    if (parts.length === 0) return null;
    return <span className={cn("text-[11px] text-muted-foreground", className)}>{parts.join(" · ")}</span>;
  }
  if (!hasGapMetadata(metadata)) return null;
  return (
    <dl className={cn("grid gap-2 text-[12px] sm:grid-cols-2", className)}>
      {metadata.stakeholders.length ? (
        <div className="grid gap-1">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Impacted stakeholders
          </dt>
          <dd className="flex flex-wrap gap-1">
            {metadata.stakeholders.map((tag) => (
              <span key={tag} className="rounded-md bg-primary/10 px-1.5 py-px text-[11px] text-indigo-800 dark:text-indigo-300">
                {tag}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {metadata.geography ? (
        <div className="grid gap-1">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Geography</dt>
          <dd className="text-foreground">{metadata.geography}</dd>
        </div>
      ) : null}
      {metadata.regional_nuances ? (
        <div className="grid gap-1 sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Regional nuances
          </dt>
          <dd className="whitespace-pre-line text-foreground">{metadata.regional_nuances}</dd>
        </div>
      ) : null}
      {metadata.notes ? (
        <div className="grid gap-1 sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Notes</dt>
          <dd className="whitespace-pre-line text-foreground">{metadata.notes}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The gap's details, on screen and editable from the start (owner feedback, KAN-52): no
 * "Add details" step. Save lights up once something changes; the change is audited.
 */
export function GapDetailsEditor({
  gapId,
  metadata,
  readOnly = false,
  className,
}: {
  gapId: string;
  metadata: GapMetadata;
  /** A retired gap, or a role that may not edit: the fields show but cannot change. */
  readOnly?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const initial = {
    stakeholders: metadata.stakeholders.join(", "),
    geography: metadata.geography,
    regional_nuances: metadata.regional_nuances,
    notes: metadata.notes,
  };
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const dirty = (Object.keys(form) as (keyof typeof form)[]).some((key) => form[key] !== saved[key]);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setMessage(null);
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  async function save() {
    setPending(true);
    setMessage(null);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_gap_metadata",
        gap_id: gapId,
        metadata: {
          stakeholders: form.stakeholders.split(/[,\n]/),
          geography: form.geography,
          regional_nuances: form.regional_nuances,
          notes: form.notes,
        },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; metadata?: GapMetadata };
    setPending(false);
    if (!res.ok || !json.metadata) {
      setMessage({ tone: "error", text: json.error ?? "Could not save the details." });
      return;
    }
    const next = {
      stakeholders: json.metadata.stakeholders.join(", "),
      geography: json.metadata.geography,
      regional_nuances: json.metadata.regional_nuances,
      notes: json.metadata.notes,
    };
    setForm(next);
    setSaved(next);
    setMessage({ tone: "ok", text: "Details saved." });
    router.refresh();
  }

  const input = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground disabled:opacity-70";
  const area = "w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-[12px] text-foreground disabled:opacity-70";
  const label = "grid gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
  return (
    <div className={cn("grid gap-2", className)} data-testid="gap-metadata">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={label}>
          Impacted stakeholders
          <input
            value={form.stakeholders}
            onChange={set("stakeholders")}
            disabled={readOnly}
            placeholder="Payers, HTA bodies, KOLs"
            className={input}
          />
        </label>
        <label className={label}>
          Geography
          <input value={form.geography} onChange={set("geography")} disabled={readOnly} placeholder="US, EU5" className={input} />
        </label>
        <label className={cn(label, "sm:col-span-2")}>
          Regional nuances
          <textarea
            rows={2}
            value={form.regional_nuances}
            onChange={set("regional_nuances")}
            disabled={readOnly}
            placeholder="How the gap differs by country or region"
            className={area}
          />
        </label>
        <label className={cn(label, "sm:col-span-2")}>
          Notes
          <textarea rows={2} value={form.notes} onChange={set("notes")} disabled={readOnly} className={area} />
        </label>
      </div>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={!dirty || pending} onClick={() => void save()}>
            {pending ? "Saving…" : "Save details"}
          </Button>
          {dirty ? (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setForm(saved)}>
              Discard
            </Button>
          ) : null}
          {message ? (
            <span
              role={message.tone === "error" ? "alert" : "status"}
              className={cn("text-[11px]", message.tone === "error" ? "text-destructive" : "text-[var(--known-foreground)]")}
            >
              {message.text}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
