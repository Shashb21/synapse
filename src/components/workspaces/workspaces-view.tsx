"use client";

import Link from "next/link";
import { useState } from "react";
import { FolderKanban, Loader2, Plus, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkspaceRole } from "@/modules/workspaces/store";
import { formatCreated, sendJson, WORKSPACE_ROLE_LABELS } from "./model";

export type WorkspaceRow = { id: string; name: string; role: WorkspaceRole; created_at: string };

/** Name a new workspace; it opens straight into setup. */
export function CreateWorkspaceForm({ autoFocus, onCancel }: { autoFocus?: boolean; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid gap-2"
      aria-label="Create a workspace"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          const json = await sendJson<{ redirect: string }>("/api/workspaces", { name });
          window.location.assign(json.redirect);
        } catch (err) {
          setPending(false);
          setError(err instanceof Error ? err.message : "Could not create the workspace.");
        }
      }}
    >
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Workspace name
        <Input
          name="workspace-name"
          value={name}
          autoFocus={autoFocus}
          placeholder="e.g. Velmara · EU launch"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="text-[11px] text-muted-foreground">
        One workspace per client, product or plan. Its gaps, tactics and sources are kept apart from every other workspace.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || name.trim().length < 2}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" aria-hidden />}
          Create workspace
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function WorkspacesView({
  workspaces,
  currentId,
  startCreating,
  next,
}: {
  workspaces: WorkspaceRow[];
  currentId: string | null;
  startCreating: boolean;
  next: string;
}) {
  const [creating, setCreating] = useState(startCreating || workspaces.length === 0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(id: string) {
    setPending(id);
    setError(null);
    try {
      const json = await sendJson<{ redirect: string }>("/api/workspaces/select", { workspace_id: id, next });
      window.location.assign(json.redirect);
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : "Could not open the workspace.");
    }
  }

  if (workspaces.length === 0) {
    return (
      <section className="border border-border bg-card/40 p-5" aria-labelledby="first-workspace">
        <h2 id="first-workspace" className="text-[15px] font-medium text-foreground">
          Create your first workspace
        </h2>
        <p className="mb-4 mt-1 text-[13px] text-muted-foreground">
          You are not in any workspace yet. Create one to start a plan, or ask a colleague to invite you to theirs.
        </p>
        <CreateWorkspaceForm autoFocus />
      </section>
    );
  }

  return (
    <div className="grid gap-4">
      <section aria-labelledby="your-workspaces" className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="your-workspaces" className="text-[15px] font-medium text-foreground">
            Your workspaces
          </h2>
          {!creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" aria-hidden />
              New workspace
            </Button>
          ) : null}
        </div>
        <ul className="grid gap-2" aria-label="Workspaces">
          {workspaces.map((ws) => (
            <li
              key={ws.id}
              data-testid="workspace-row"
              className="flex flex-wrap items-center gap-3 border border-border bg-card/40 px-3 py-2.5"
            >
              <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-foreground">{ws.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {WORKSPACE_ROLE_LABELS[ws.role]} · created {formatCreated(ws.created_at)}
                </p>
              </div>
              {ws.id === currentId ? <Badge variant="secondary">Current</Badge> : null}
              <Link
                href={`/workspaces/${ws.id}`}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
                aria-label={`Settings for ${ws.name}`}
              >
                <Settings className="size-3.5" aria-hidden />
                Settings
              </Link>
              <Button size="sm" onClick={() => void open(ws.id)} disabled={pending !== null} aria-label={`Open ${ws.name}`}>
                {pending === ws.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Open
              </Button>
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {creating ? (
        <section className="border border-border bg-card/40 p-4" aria-labelledby="new-workspace">
          <h2 id="new-workspace" className="mb-3 text-[15px] font-medium text-foreground">
            New workspace
          </h2>
          <CreateWorkspaceForm autoFocus onCancel={() => setCreating(false)} />
        </section>
      ) : null}
    </div>
  );
}
