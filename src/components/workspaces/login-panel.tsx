"use client";

import Link from "next/link";
import { useState } from "react";
import { FlaskConical, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sendJson } from "./model";

/**
 * Sign-in choices: email and password first (everyone can have an account),
 * then one button per configured identity provider, and — only outside
 * production — a demo sign-in so local preview and tests work without SSO
 * credentials.
 */
export function LoginPanel({
  providers,
  demo,
  signup,
  next,
  initialError,
}: {
  providers: { id: string; label: string }[];
  demo: boolean;
  /** Self sign-up is open (ALLOW_SIGNUP is not "0"). */
  signup: boolean;
  next: string;
  initialError: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
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

      <form
        className="grid gap-2"
        aria-label="Sign in with email"
        onSubmit={(event) => {
          event.preventDefault();
          void signIn({ email: loginEmail, password }, "password", "/api/auth/password/login");
        }}
      >
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
        {signup ? (
          <p className="text-center text-[12px] text-muted-foreground">
            New to Synapse?{" "}
            <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"} className="text-foreground underline underline-offset-2">
              Create an account
            </Link>
          </p>
        ) : null}
      </form>

      {providers.length > 0 ? (
        <div className="grid gap-2 border-t border-border pt-4">
          <p className="text-[11px] text-muted-foreground">Or use your organisation&apos;s single sign-on</p>
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

      {demo ? (
        <form
          className="grid gap-2 border-t border-border pt-4"
          aria-label="Demo sign-in"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn({ demo: true, actor_name: name, email: email || undefined }, "demo");
          }}
        >
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FlaskConical className="size-3.5" aria-hidden />
            Development only. Never offered to customers in production.
          </p>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Your name
            <Input value={name} placeholder="e.g. Alex Morgan" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Email (optional, so workspace invites reach you)
            <Input
              type="email"
              value={email}
              placeholder="alex@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <Button type="submit" variant="secondary" disabled={pending !== null || !name.trim()}>
            {pending === "demo" ? <Loader2 className="size-4 animate-spin" /> : null}
            Continue as a demo user (development only)
          </Button>
        </form>
      ) : null}
    </div>
  );
}
