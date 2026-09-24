"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

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
 * setting. Saves on every add or remove.
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
  const [tags, setTags] = useState(settings);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(next: string[]) {
    const previous = tags;
    setTags(next);
    setPending(true);
    setError(null);
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_gap_settings", gap_id: gapId, settings: next }),
    });
    const json = (await res.json().catch(() => ({}))) as { settings?: string[]; error?: string };
    setPending(false);
    if (!res.ok) {
      setTags(previous);
      setError(json.error ?? "Could not save the settings.");
      return;
    }
    setTags(json.settings ?? next);
    router.refresh();
  }

  function add(raw: string) {
    const typed = raw.trim().replace(/\s+/g, " ");
    if (!typed) return;
    // Reuse the existing spelling when the tag is already in use elsewhere.
    const tag = options.find((option) => option.toLowerCase() === typed.toLowerCase()) ?? typed;
    setDraft("");
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    void save([...tags, tag]);
  }

  const suggestions = options.filter(
    (option) => !tags.some((tag) => tag.toLowerCase() === option.toLowerCase()),
  );

  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Settings</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 py-px pl-1.5 pr-0.5 text-[11px] text-foreground"
          >
            {tag}
            <button
              type="button"
              disabled={pending}
              onClick={() => void save(tags.filter((existing) => existing !== tag))}
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
            className="h-7 w-40 rounded-md border border-input bg-transparent px-2 text-[12px] text-foreground"
          />
          <datalist id={listId}>
            {suggestions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </form>
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
