"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ExternalLink, Layers, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { postJson } from "@/lib/post-json";

export type BreakoutGapRow = {
  id: string;
  name: string;
  domain: string;
  settings: string[];
  priority: string;
  group_ids: string[];
};

export type BreakoutGroupRow = { id: string; name: string; note: string | null; gap_ids: string[] };

export type ThemePreview = {
  theme: "domain" | "setting" | "priority";
  label: string;
  buckets: { label: string; count: number; unassigned: number }[];
};

const FIELD = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

async function post(body: Record<string, unknown>): Promise<string | null> {
  const res = await postJson("/api/iegp", body);
  if (res.ok) return null;
  return (res.json as { error?: string }).error ?? "Could not save.";
}

/** New group: a name, what it covers, and optionally the gaps of one theme to start with. */
function NewGroupDialog({ gaps, themes }: { gaps: BreakoutGapRow[]; themes: ThemePreview[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [theme, setTheme] = useState<ThemePreview["theme"] | "">("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buckets = themes.find((row) => row.theme === theme)?.buckets ?? [];
  const starting = useMemo(() => {
    if (!theme || !value) return [];
    return gaps.filter((gap) =>
      theme === "domain" ? gap.domain === value : theme === "setting" ? (value === "No setting" ? gap.settings.length === 0 : gap.settings.includes(value)) : gap.priority === value,
    );
  }, [gaps, theme, value]);

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setName("");
      setNote("");
      setTheme("");
      setValue("");
      setError(null);
    }
  }

  async function create() {
    if (!name.trim()) {
      setError("Give the group a name.");
      return;
    }
    setPending(true);
    setError(null);
    const failed = await post({
      action: "create_breakout_group",
      name: name.trim(),
      note: note.trim(),
      gap_ids: starting.map((gap) => gap.id).join(","),
    });
    if (failed) {
      setPending(false);
      setError(failed);
      return;
    }
    setPending(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-3.5" /> New breakout group
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New breakout group</DialogTitle>
          <DialogDescription>Name it for what the group will discuss. You can add or move gaps any time.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className={LABEL}>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Payer evidence" className={FIELD} />
          </label>
          <label className={LABEL}>
            What it covers (optional)
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="The question this group answers" className={FIELD} />
          </label>
          <div className="grid gap-2 rounded-md border border-dashed border-border p-2">
            <p className="text-[11px] text-muted-foreground">Start with the gaps of one theme (optional)</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={LABEL}>
                Theme
                <select
                  value={theme}
                  onChange={(event) => {
                    setTheme(event.target.value as ThemePreview["theme"] | "");
                    setValue("");
                  }}
                  className={FIELD}
                >
                  <option value="">No theme</option>
                  {themes.map((row) => (
                    <option key={row.theme} value={row.theme}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Value
                <select value={value} onChange={(event) => setValue(event.target.value)} className={FIELD} disabled={!theme}>
                  <option value="">{theme ? "Choose one" : "—"}</option>
                  {buckets.map((bucket) => (
                    <option key={bucket.label} value={bucket.label}>
                      {bucket.label} ({bucket.count})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {starting.length > 0 ? (
              <p className="text-[11px] text-foreground">Starts with {starting.length} gap{starting.length === 1 ? "" : "s"}.</p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => void create()} disabled={pending}>
            {pending ? "Creating…" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One group per theme value, each starting with its gaps. */
function GroupByThemeDialog({ themes }: { themes: ThemePreview[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreview["theme"]>(themes[0]?.theme ?? "domain");
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = (themes.find((row) => row.theme === theme)?.buckets ?? []).filter((bucket) =>
    onlyUnassigned ? bucket.unassigned > 0 : bucket.count > 0,
  );

  async function create() {
    setPending(true);
    setError(null);
    const failed = await post({ action: "create_breakout_groups_by_theme", theme, only_unassigned: onlyUnassigned });
    setPending(false);
    if (failed) {
      setError(failed);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (setOpen(next), setError(null))}>
      <DialogTrigger render={<Button variant="outline" />}>
        <Layers className="size-3.5" /> Group gaps by theme
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Group gaps by theme</DialogTitle>
          <DialogDescription>
            Creates one breakout group per theme value, each starting with its gaps. A group that already has that
            name gets the gaps added instead.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-1">
            {themes.map((row) => (
              <button
                key={row.theme}
                type="button"
                role="radio"
                aria-checked={theme === row.theme}
                onClick={() => setTheme(row.theme)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11px] font-medium",
                  theme === row.theme ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground",
                )}
              >
                {row.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-foreground">
            <input type="checkbox" checked={onlyUnassigned} onChange={(event) => setOnlyUnassigned(event.target.checked)} />
            Only gaps not in a group yet
          </label>
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Groups to create ({preview.length})
            </p>
            {preview.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">Nothing to group for this theme.</p>
            ) : (
              <ul className="grid max-h-56 gap-1 overflow-y-auto" aria-label="Groups to create">
                {preview.map((bucket) => (
                  <li key={bucket.label} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-[12px]">
                    <span className="text-foreground">{bucket.label}</span>
                    <span className="text-muted-foreground">
                      {onlyUnassigned ? bucket.unassigned : bucket.count} gap
                      {(onlyUnassigned ? bucket.unassigned : bucket.count) === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error ? (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => void create()} disabled={pending || preview.length === 0}>
            {pending ? "Creating…" : `Create ${preview.length} group${preview.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteGroupButton({ group }: { group: BreakoutGroupRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Delete ${group.name}`} />}>
        <Trash2 className="size-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete “{group.name}”?</DialogTitle>
          <DialogDescription>
            Its {group.gap_ids.length} gap{group.gap_ids.length === 1 ? " is" : "s are"} taken out of the group. The gaps
            themselves are not changed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              await post({ action: "delete_breakout_group", group_id: group.id });
              setPending(false);
              setOpen(false);
              router.refresh();
            }}
          >
            Delete group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Puts an ungrouped gap into a group straight from the list. */
function AssignSelect({ gap, groups }: { gap: BreakoutGapRow; groups: BreakoutGroupRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <select
      aria-label={`Add ${gap.name} to a group`}
      value=""
      disabled={pending || groups.length === 0}
      onChange={async (event) => {
        const group_id = event.target.value;
        if (!group_id) return;
        setPending(true);
        await post({ action: "assign_gaps_to_breakout", group_id, gap_ids: gap.id });
        setPending(false);
        router.refresh();
      }}
      className="h-7 max-w-[12rem] rounded-md border border-input bg-card px-2 text-[11px] text-foreground"
    >
      <option value="">{pending ? "Adding…" : "Add to group…"}</option>
      {groups.map((group) => (
        <option key={group.id} value={group.id}>
          {group.name}
        </option>
      ))}
    </select>
  );
}

/** Breakout groups (owner feedback, KAN-55): create, group by theme, and see what is unassigned. */
export function BreakoutsOverview({
  groups,
  gaps,
  themes,
}: {
  groups: BreakoutGroupRow[];
  gaps: BreakoutGapRow[];
  themes: ThemePreview[];
}) {
  const byId = new Map(gaps.map((gap) => [gap.id, gap]));
  const unassigned = gaps.filter((gap) => gap.group_ids.length === 0);
  const assignedCount = gaps.length - unassigned.length;

  return (
    <div className="grid gap-4" data-testid="breakouts-overview">
      <div className="flex flex-wrap items-center gap-2">
        <NewGroupDialog gaps={gaps} themes={themes} />
        <GroupByThemeDialog themes={themes} />
        <p className="ml-auto text-[11px] text-muted-foreground">
          {groups.length} group{groups.length === 1 ? "" : "s"} · {assignedCount} of {gaps.length} gaps in a group
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <Users className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-[12px] text-foreground">No breakout groups yet.</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Create one, or group the {gaps.length} gap{gaps.length === 1 ? "" : "s"} by theme in one step.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Breakout groups">
          {groups.map((group) => {
            const members = group.gap_ids.map((id) => byId.get(id)).filter((gap): gap is BreakoutGapRow => Boolean(gap));
            // A group made from one domain already says so in its name; the chip would only repeat it.
            const domains = [...new Set(members.map((gap) => gap.domain))].filter(
              (domain, _, all) => !(all.length === 1 && domain.toLowerCase() === group.name.toLowerCase()),
            );
            return (
              <li key={group.id} className="grid content-start gap-2 rounded-lg border border-border bg-card p-4" data-testid="breakout-group">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-[13px] font-semibold text-foreground">{group.name}</h2>
                    {group.note ? <p className="text-[11px] leading-4 text-muted-foreground">{group.note}</p> : null}
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-indigo-800 dark:text-indigo-300">
                    {members.length} gap{members.length === 1 ? "" : "s"}
                  </span>
                </div>
                {domains.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {domains.slice(0, 4).map((domain) => (
                      <span key={domain} className="rounded-sm bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                        {domain}
                      </span>
                    ))}
                  </div>
                ) : null}
                <ul className="grid gap-0.5 text-[11px] text-foreground">
                  {members.slice(0, 3).map((gap) => (
                    <li key={gap.id} className="truncate">
                      <span className="font-mono text-[10px] text-primary">{gap.id}</span> {gap.name}
                    </li>
                  ))}
                  {members.length > 3 ? <li className="text-muted-foreground">+ {members.length - 3} more</li> : null}
                  {members.length === 0 ? <li className="text-muted-foreground">No gaps yet.</li> : null}
                </ul>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Link
                    href={`/breakouts/${group.id}`}
                    className="inline-flex h-8 items-center rounded-lg bg-primary px-2.5 text-[12px] font-medium text-primary-foreground no-underline hover:bg-primary/80"
                  >
                    Open group
                  </Link>
                  <Link
                    href={`/breakouts/${group.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${group.name} in a new window`}
                    title="Open in a new window, for another screen or consultant"
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-[12px] text-foreground no-underline hover:bg-muted"
                  >
                    <ExternalLink className="size-3.5" /> New window
                  </Link>
                  <span className="ml-auto">
                    <DeleteGroupButton group={group} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <section aria-labelledby="unassigned-gaps" className="rounded-lg border border-border bg-card p-4">
        <h2 id="unassigned-gaps" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Not in a group yet ({unassigned.length})
        </h2>
        {unassigned.length === 0 ? (
          <p className="mt-2 text-[12px] text-muted-foreground">Every gap is in a group.</p>
        ) : (
          <ul className="mt-2 grid gap-1" aria-label="Gaps not in a group">
            {unassigned.map((gap) => (
              <li key={gap.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5">
                <span className="font-mono text-[10px] text-primary">{gap.id}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{gap.name}</span>
                <span className="text-[10px] text-muted-foreground">{gap.domain}</span>
                <AssignSelect gap={gap} groups={groups} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
