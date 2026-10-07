"use client";

import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sendJson } from "./model";

/**
 * Sign-in choices: one button per configured identity provider (customers
 * sign in with SSO and a seat their organisation assigned), then email and
 * password for Synapse staff and the test customer account (KAN-59). There is
 * no self sign-up. The demo sign-in is not offered here (KAN-59); it remains
 * an API for automated tests in development builds only.
 */
export function LoginPanel({
  providers,
  next,
  initialError,
}: {
  providers: { id: string; label: string }[];
  next: string;
  initialError: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [loginEmail, setLoginEmail] = useState("");
  const [password, setPassword] = useState("");

  async function signIn(body: Record<string, unknown>, key: string, url = "/api/auth/login") {
    setPending(key);
    setError(null);
    try {
      const json = await sendJson<{ authorize_url?: string; redirect?: string }>(url, { ...body, next });
      window.location.assign(json.authorize_url ?? json.redirect ?? "/workspaces");
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    }
  }

  return (
    <div className="grid gap-4">
      {error ? (
        <p role="alert" data-testid="login-error" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      {providers.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-[11px] text-muted-foreground">Sign in with your organisation&apos;s single sign-on</p>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              size="lg"
              variant="outline"
              className="w-full justify-center"
              disabled={pending !== null}
              onClick={() => void signIn({ provider_id: provider.id }, provider.id)}
            >
              {pending === provider.id ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" aria-hidden />}
              Continue with {provider.label}
            </Button>
          ))}
        </div>
      ) : null}

      <form
        className={providers.length > 0 ? "grid gap-2 border-t border-border pt-4" : "grid gap-2"}
        aria-label="Sign in with email"
        onSubmit={(event) => {
          event.preventDefault();
          void signIn({ email: loginEmail, password }, "password", "/api/auth/password/login");
        }}
      >
        <p className="text-[11px] text-muted-foreground">Email and password</p>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Email
          <Input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={loginEmail}
            onChange={(event) => setLoginEmail(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Password
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <Button type="submit" size="lg" disabled={pending !== null || !loginEmail.trim() || !password}>
          {pending === "password" ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" aria-hidden />}
          Sign in
        </Button>
      </form>

    </div>
  );
}
