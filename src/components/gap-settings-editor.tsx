"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { postJson } from "@/lib/post-json";

/** Setting tags as small chips, read-only. */
export function SettingChips({ settings, className }: { settings: string[]; className?: string }) {
  if (settings.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {settings.map((tag) => (
        <span
          key={tag}
          className="rounded-md border border-border bg-muted/40 px-1.5 py-px text-[10px] text-foreground"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

/**
 * Treatment settings on one gap (1L, Perioperative, Metastatic…). Free tags, so
 * typing suggests the tags already used on other gaps to keep one spelling per
 * setting. Changes are saved together with a reason.
 */
export function GapSettingsEditor({
  gapId,
  settings,
  options,
}: {
  gapId: string;
  settings: string[];
  options: string[];
}) {
  const router = useRouter();
  const listId = useId();
  const errorId = useId();
  const [tags, setTags] = useState(settings);
  const [savedTags, setSavedTags] = useState(settings);
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dirty = JSON.stringify(tags) !== JSON.stringify(savedTags);

  async function save() {
    if (reason.trim().length < 3) {
      setError("A meaningful reason is required for the settings change.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await postJson("/api/plan", { action: "set_gap_settings", gap_id: gapId, settings: tags, expected_settings: savedTags, rationale: reason });
    const json = res.json as { settings?: string[]; error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Could not save the settings.");
      return;
    }
    setTags(json.settings ?? tags);
    setSavedTags(json.settings ?? tags);
    setReason("");
    router.refresh();
  }

  function add(raw: string) {
    const typed = raw.trim().replace(/\s+/g, " ");
    if (!typed) return;
    // Reuse the existing spelling when the tag is already in use elsewhere.
    const tag = options.find((option) => option.toLowerCase() === typed.toLowerCase()) ?? typed;
    setDraft("");
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    setTags([...tags, tag]);
  }

  const suggestions = options.filter(
    (option) => !tags.some((tag) => tag.toLowerCase() === option.toLowerCase()),
  );

  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Settings</p>
      <div className="flex flex-wrap items-center gap-1.5" aria-busy={pending}>
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 py-px pl-1.5 pr-0.5 text-[11px] text-foreground"
          >
            {tag}
            <button
              type="button"
              disabled={pending}
              onClick={() => setTags(tags.filter((existing) => existing !== tag))}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove ${tag}`}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            add(draft);
          }}
        >
          <input
            value={draft}
            list={listId}
            disabled={pending}
            onChange={(event) => {
              const value = event.target.value;
              if (value.endsWith(",")) add(value.slice(0, -1));
              else setDraft(value);
            }}
            onBlur={() => add(draft)}
            placeholder={tags.length ? "Add setting" : "Tag a setting, e.g. 1L"}
            aria-label="Add a treatment setting"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="h-7 w-40 rounded-md border border-input bg-transparent px-2 text-[12px] text-foreground"
          />
          <datalist id={listId}>
            {suggestions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </form>
      </div>
      {dirty ? (
        <div className="grid gap-2">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Reason for settings change (required)
            <textarea value={reason} onChange={event => setReason(event.target.value)} disabled={pending} className="rounded-lg border border-input bg-card px-2.5 py-1.5" />
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => void save()}>Save settings</Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { setTags(savedTags); setDraft(""); setReason(""); setError(null); }}>Discard settings</Button>
          </div>
        </div>
      ) : null}
      {pending ? <p role="status" className="text-[11px] text-muted-foreground">Saving settings…</p> : null}
      {error ? <>
        <p id={errorId} role="alert" className="text-[11px] text-destructive">{error} Changes have not been saved.</p>
        <button type="button" disabled={pending} onClick={() => void save()} className="justify-self-start text-[12px] underline focus-visible:outline-2 focus-visible:outline-ring">Retry saving settings</button>
      </> : null}
    </div>
  );
}
