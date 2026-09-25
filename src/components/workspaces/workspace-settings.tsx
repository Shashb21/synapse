"use client";

import { useState } from "react";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkspaceMember, WorkspaceRole } from "@/modules/workspaces/store";
import { formatCreated, sendJson, WORKSPACE_ROLE_LABELS } from "./model";

/** Rename (owner), see who is in, invite by email (any member), remove people (owner). */
export function WorkspaceSettings({
  workspace,
  members: initialMembers,
  me,
}: {
  workspace: { id: string; name: string; role: WorkspaceRole; created_at: string };
  members: WorkspaceMember[];
  me: string;
}) {
  const owner = workspace.role === "owner";
  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [members, setMembers] = useState(initialMembers);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>) {
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setPending(null);
    }
  }

  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="ws-name" className="grid gap-2">
        <h2 id="ws-name" className="text-[15px] font-medium text-foreground">
          Name
        </h2>
        {owner ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run("rename", async () => {
                await sendJson(base, { name }, "PATCH");
                setSavedName(name.trim());
                setNotice("Workspace renamed.");
              });
            }}
          >
            <label className="grid min-w-56 flex-1 gap-1 text-[12px] text-muted-foreground">
              Workspace name
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <Button type="submit" disabled={pending !== null || name.trim() === savedName || name.trim().length < 2}>
              {pending === "rename" ? <Loader2 className="size-4 animate-spin" /> : null}
              Rename
            </Button>
          </form>
        ) : (
          <p className="text-[13px] text-foreground">
            {savedName} <span className="text-[11px] text-muted-foreground">(only the owner can rename it)</span>
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">Created {formatCreated(workspace.created_at)}</p>
      </section>

      <section aria-labelledby="ws-members" className="grid gap-2">
        <h2 id="ws-members" className="text-[15px] font-medium text-foreground">
          Members
        </h2>
        <ul className="grid gap-1" aria-label="Members">
          {members.map((member) => (
            <li
              key={member.principal}
              data-testid="member-row"
              className="flex flex-wrap items-center gap-2 border border-border bg-card/40 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {member.principal}
                {member.principal === me ? <span className="text-muted-foreground"> (you)</span> : null}
              </span>
              <Badge variant={member.role === "owner" ? "default" : "secondary"}>{WORKSPACE_ROLE_LABELS[member.role]}</Badge>
              {owner && member.role !== "owner" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${member.principal}`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`remove:${member.principal}`, async () => {
                      const json = await sendJson<{ members: WorkspaceMember[] }>(
                        `${base}/members`,
                        { principal: member.principal },
                        "DELETE",
                      );
                      setMembers(json.members);
                      setNotice(`${member.principal} was removed.`);
                    })
                  }
                >
                  {pending === `remove:${member.principal}` ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <UserMinus className="size-3.5" aria-hidden />
                  )}
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          aria-label="Invite someone"
          onSubmit={(event) => {
            event.preventDefault();
            void run("invite", async () => {
              const json = await sendJson<{ members: WorkspaceMember[] }>(`${base}/members`, { email });
              setMembers(json.members);
              setNotice(`${email.trim()} can now open this workspace when they sign in.`);
              setEmail("");
            });
          }}
        >
          <label className="grid min-w-56 flex-1 gap-1 text-[12px] text-muted-foreground">
            Invite by email
            <Input
              type="email"
              name="invite-email"
              value={email}
              placeholder="colleague@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={pending !== null || !email.trim()}>
            {pending === "invite" ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" aria-hidden />}
            Invite
          </Button>
        </form>
        <p className="text-[11px] text-muted-foreground">
          Invited people see this workspace the next time they sign in with that email address.
        </p>
      </section>

      {notice ? (
        <p role="status" className="text-[12px] text-emerald-300">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
