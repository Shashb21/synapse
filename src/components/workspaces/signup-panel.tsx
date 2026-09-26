"use client";

import { useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import { sendJson } from "./model";

/** Self sign-up: name, email, function and a password (entered twice). */
export function SignupPanel({ next, minLength }: { next: string; minLength: number }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fn, setFn] = useState<ActorFunction>("medical_affairs");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = name.trim() && email.trim() && password.length >= minLength && confirm === password;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const json = await sendJson<{ redirect?: string }>("/api/auth/password/signup", {
        name,
        email,
        actor_function: fn,
        password,
        confirm,
        next,
      });
      window.location.assign(json.redirect ?? "/workspaces");
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : "Sign-up failed.");
    }
  }

  return (
    <form
      className="grid gap-3"
      aria-label="Create an account"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error ? (
        <p role="alert" data-testid="signup-error" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Your name
        <Input value={name} autoComplete="name" required onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Work email
        <Input type="email" value={email} autoComplete="email" required onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Your function
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground"
          value={fn}
          onChange={(event) => setFn(event.target.value as ActorFunction)}
        >
          {ACTOR_FUNCTIONS.map((value) => (
            <option key={value} value={value}>
              {FUNCTION_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Password
        <Input
          type="password"
          value={password}
          autoComplete="new-password"
          minLength={minLength}
          required
          aria-describedby="password-hint"
          onChange={(event) => setPassword(event.target.value)}
        />
        <span id="password-hint">At least {minLength} characters. Not your email, not a common password.</span>
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Confirm password
        <Input
          type="password"
          value={confirm}
          autoComplete="new-password"
          required
          aria-invalid={mismatch || undefined}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {mismatch ? <span className="text-destructive">The passwords do not match.</span> : null}
      </label>
      <Button type="submit" size="lg" disabled={pending || !ready}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" aria-hidden />}
        Create account
      </Button>
    </form>
  );
}
