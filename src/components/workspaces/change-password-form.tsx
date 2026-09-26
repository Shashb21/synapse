"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sendJson } from "./model";

/** Change your own password: the current one, then the new one twice. */
export function ChangePasswordForm({ minLength }: { minLength: number }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== next;

  async function submit() {
    setPending(true);
    setError(null);
    setDone(false);
    try {
      await sendJson("/api/account/password", { current, next, confirm });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="grid gap-3"
      aria-label="Change password"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error ? (
        <p role="alert" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" data-testid="password-changed" className="border border-border px-3 py-2 text-[12px] text-foreground">
          Password changed. Your other sessions have been signed out.
        </p>
      ) : null}
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Current password
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        New password
        <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <span>At least {minLength} characters. Not your email, not a common password.</span>
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Confirm new password
        <Input
          type="password"
          autoComplete="new-password"
          value={confirm}
          aria-invalid={mismatch || undefined}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch ? <span className="text-destructive">The passwords do not match.</span> : null}
      </label>
      <Button type="submit" disabled={pending || !current || next.length < minLength || confirm !== next}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Change password
      </Button>
    </form>
  );
}
