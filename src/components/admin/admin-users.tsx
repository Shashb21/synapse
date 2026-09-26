"use client";

import { useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS } from "@/lib/iegp/enums";
import { ROLE_LABELS, ROLES, type Role } from "@/modules/auth/roles";
import type { AdminUserView } from "@/modules/auth/admin-users";

type Result = { user: AdminUserView; temporary_password?: string; error?: string };

async function call(body: Record<string, unknown>): Promise<Result> {
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Result;
  if (!res.ok) throw new Error(json.error ?? `Request failed (HTTP ${res.status}).`);
  return json;
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "never";
}

/** The Users table: every email + password account, and what an admin can do to each. */
export function AdminUsers({ initialUsers, selfId }: { initialUsers: AdminUserView[]; selfId: string | null }) {
  const [users, setUsers] = useState(initialUsers);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("contributor");
  const [fn, setFn] = useState<string>("medical_affairs");

  function replace(user: AdminUserView) {
    setUsers((list) => (list.some((u) => u.id === user.id) ? list.map((u) => (u.id === user.id ? user : u)) : [...list, user]));
  }

  async function run(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const result = await call(body);
      replace(result.user);
      setSecret(result.temporary_password ? { email: result.user.email, password: result.temporary_password } : null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6">
      {error ? (
        <p role="alert" data-testid="users-error" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      {secret ? (
        <div role="status" data-testid="temporary-password" className="grid gap-1 border border-primary/40 bg-primary/5 px-3 py-2 text-[12px]">
          <p className="text-foreground">
            Temporary password for <span className="font-medium">{secret.email}</span>. It is shown only this once: copy
            it now and share it securely. They can change it at /account.
          </p>
          <code className="select-all break-all bg-background px-2 py-1 font-mono text-[13px] text-foreground">{secret.password}</code>
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setSecret(null)}>
            Done, hide it
          </Button>
        </div>
      ) : null}

      <form
        aria-label="Create a user"
        className="grid gap-2 border border-border bg-card/40 p-4 sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await run("create", { action: "create", email, name, role, actor_function: fn });
          if (ok) {
            setEmail("");
            setName("");
          }
        }}
      >
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Email
          <Input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Name
          <Input value={name} required onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Role
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Function
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground"
            value={fn}
            onChange={(e) => setFn(e.target.value)}
          >
            {ACTOR_FUNCTIONS.map((value) => (
              <option key={value} value={value}>
                {FUNCTION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={busy !== null || !email.trim() || !name.trim()}>
          {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" aria-hidden />}
          Create user
        </Button>
      </form>

      <div className="overflow-x-auto border border-border">
        <table className="w-full min-w-[900px] text-left text-[12px]">
          <thead className="bg-muted/40 text-[11px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Admin</th>
              <th className="px-3 py-2 font-medium">Verified</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Last sign-in</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-muted-foreground">
                  No email and password accounts yet.
                </td>
              </tr>
            ) : null}
            {users.map((user) => {
              const self = user.id === selfId;
              const pending = busy?.endsWith(user.id) ?? false;
              return (
                <tr key={user.id} data-testid="user-row" className="border-t border-border align-top">
                  <td className="px-3 py-2 text-foreground">
                    {user.email}
                    {self ? <span className="ml-1 text-muted-foreground">(you)</span> : null}
                  </td>
                  <td className="px-3 py-2 text-foreground">{user.name}</td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Role for ${user.email}`}
                      className="h-7 rounded-md border border-input bg-background px-1 text-[12px] text-foreground disabled:opacity-60"
                      value={user.role}
                      disabled={self || busy !== null}
                      title={self ? "You can't change your own role." : undefined}
                      onChange={(e) => void run(`role:${user.id}`, { action: "set_role", id: user.id, role: e.target.value })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">{user.is_admin ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">{user.email_verified ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">
                    {user.disabled ? "Disabled" : user.locked ? `Locked until ${when(user.locked_until)}` : "Active"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{when(user.last_sign_in_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void run(`reset:${user.id}`, { action: "reset_password", id: user.id })}
                      >
                        Reset password
                      </Button>
                      {!user.email_verified ? (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`verify:${user.id}`, { action: "verify", id: user.id })}>
                          Verify email
                        </Button>
                      ) : null}
                      {user.locked ? (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`unlock:${user.id}`, { action: "unlock", id: user.id })}>
                          Unlock
                        </Button>
                      ) : null}
                      {!self ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void run(`admin:${user.id}`, { action: "set_admin", id: user.id, is_admin: !user.is_admin })}
                        >
                          {user.is_admin ? "Remove admin" : "Make admin"}
                        </Button>
                      ) : null}
                      {!self ? (
                        <Button
                          size="sm"
                          variant={user.disabled ? "outline" : "destructive"}
                          disabled={busy !== null}
                          onClick={() => void run(`disable:${user.id}`, { action: "set_disabled", id: user.id, disabled: !user.disabled })}
                        >
                          {user.disabled ? "Enable" : "Disable"}
                        </Button>
                      ) : null}
                      {pending ? <Loader2 className="size-4 animate-spin self-center" aria-label="Working" /> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
