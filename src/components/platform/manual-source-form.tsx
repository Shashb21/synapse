"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionField, ActionIdentity } from "@/components/platform/action-dialog";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import { splitParagraphs } from "@/lib/ingest/manual-blocks";

type DraftBlock = { key: number; text: string; heading: string; kind: string };

/**
 * Manual source entry, no AI: paste or type the text, split it into one block
 * per paragraph, adjust each block (text, heading, kind), then save. Every
 * block is stored as human-entered with the rationale on the audit trail.
 */
export function ManualSourceForm({
  endpoint,
  payload,
  fields,
  kindOptions,
  identity,
  onSavedHref,
}: {
  endpoint: string;
  payload: Record<string, unknown>;
  /** Source metadata (title, type, stakeholder function…). */
  fields: ActionField[];
  /** Block kinds the store accepts; omitted when blocks have no kind. */
  kindOptions?: readonly string[];
  identity: ActionIdentity;
  /** Where to go after saving; `{id}` is replaced with the new source id. */
  onSavedHref?: string;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [blocks, setBlocks] = useState<DraftBlock[]>([]);
  const [rationale, setRationale] = useState("");
  const [actorName, setActorName] = useState(identity.signed_in ? identity.actor_name : "");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(identity.actor_function);
  const [meta, setMeta] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? f.options?.[0]?.value ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const defaultKind = kindOptions?.[0] ?? "";

  function split() {
    const parts = splitParagraphs(raw);
    setBlocks(parts.map((text, key) => ({ key, text, heading: "", kind: defaultKind })));
    setSaved(null);
  }

  function update(key: number, patch: Partial<DraftBlock>) {
    setBlocks((current) => current.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  async function save() {
    setError(null);
    const kept = blocks.filter((b) => b.text.trim());
    if (kept.length === 0) return setError("Split the text into blocks (or add one) before saving.");
    if (rationale.trim().length < 3) return setError("A short rationale (3+ characters) is required.");
    if (!identity.signed_in && !actorName.trim()) return setError("Type your name so the entry has an actor.");
    for (const field of fields) {
      if (field.required && !meta[field.name]?.trim()) return setError(`${field.label} is required.`);
    }
    setPending(true);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        ...meta,
        action: "manual_source",
        blocks: kept.map((b) => ({
          text: b.text,
          heading: b.heading.trim() || undefined,
          ...(kindOptions ? { kind: b.kind } : {}),
        })),
        rationale,
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: actorFunction,
      }),
    });
    const json = (await res.json()) as { error?: string; source_id?: string; source_file_id?: string };
    setPending(false);
    if (!res.ok) return setError(json.error ?? "Save failed");
    const id = json.source_id ?? json.source_file_id ?? "";
    setSaved(id);
    setBlocks([]);
    setRaw("");
    setRationale("");
    if (onSavedHref) router.push(onSavedHref.replace("{id}", encodeURIComponent(id)));
    else router.refresh();
  }

  return (
    <div className="grid gap-3 text-[12px]" data-testid="manual-source-form">
      <div className="grid gap-2 sm:grid-cols-3">
        {fields.map((field) => (
          <label key={field.name} className="grid gap-1 text-muted-foreground">
            {field.label}
            {field.type === "select" ? (
              <select
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                value={meta[field.name]}
                onChange={(e) => setMeta({ ...meta, [field.name]: e.target.value })}
              >
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={meta[field.name]}
                placeholder={field.placeholder}
                onChange={(e) => setMeta({ ...meta, [field.name]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      <label className="grid gap-1 text-muted-foreground">
        Paste or type the source text
        <Textarea rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paragraphs separated by a blank line" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={split} disabled={!raw.trim()}>
          Split into paragraphs
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            setBlocks((current) => [...current, { key: Date.now(), text: "", heading: "", kind: defaultKind }])
          }
        >
          Add a block
        </Button>
      </div>
      {blocks.length > 0 ? (
        <ol className="grid gap-2">
          {blocks.map((block, index) => (
            <li key={block.key} className="grid gap-1 border border-border/60 bg-card/30 p-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>Block {index + 1} · human-entered</span>
                <Input
                  className="h-7 max-w-56"
                  value={block.heading}
                  placeholder="Heading (optional)"
                  onChange={(e) => update(block.key, { heading: e.target.value })}
                />
                {kindOptions ? (
                  <select
                    className="h-7 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
                    value={block.kind}
                    onChange={(e) => update(block.key, { kind: e.target.value })}
                  >
                    {kindOptions.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setBlocks((current) => current.filter((b) => b.key !== block.key))}
                >
                  Remove
                </Button>
              </div>
              <Textarea rows={3} value={block.text} onChange={(e) => update(block.key, { text: e.target.value })} />
            </li>
          ))}
        </ol>
      ) : null}
      <label className="grid gap-1 text-muted-foreground">
        Rationale (required)
        <Textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this source is entered by hand" />
      </label>
      {!identity.signed_in ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-muted-foreground">
            Name
            <Input value={actorName} placeholder="Your name" onChange={(e) => setActorName(e.target.value)} />
          </label>
          <label className="grid gap-1 text-muted-foreground">
            Function
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
              value={actorFunction}
              onChange={(e) => setActorFunction(e.target.value as ActorFunction)}
            >
              {ACTOR_FUNCTIONS.map((fn) => (
                <option key={fn} value={fn}>
                  {FUNCTION_LABELS[fn]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
      {saved ? <p className="text-muted-foreground">Saved as human-entered source {saved}.</p> : null}
      <div>
        <Button type="button" size="sm" onClick={() => void save()} disabled={pending || blocks.length === 0}>
          {pending ? "Saving…" : `Save ${blocks.length} human-entered block(s)`}
        </Button>
      </div>
    </div>
  );
}
