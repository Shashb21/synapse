"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import { ROLES, ROLE_LABELS, type Role } from "@/modules/auth/roles";
import { postJson } from "@/lib/post-json";

/** Demo sign-in is for local preview and tests only; a production build never offers it. */
const DEMO_SIGN_IN = process.env.NODE_ENV !== "production";

/**
 * Identity for the session: SSO sign-in (Google, Microsoft, GitHub), plus a
 * demo sign-in outside production. Signing in goes through /api/auth, so it
 * lands on the workspace picker like the /login page.
 */
export function SessionPanel({
  actorName,
  role,
  signedIn,
  demo,
  providers,
  demoSession,
  owner = false,
}: {
  actorName: string;
  role: Role;
  signedIn: boolean;
  /** No configured identity providers; independent of the signed-in session provider. */
  demo: boolean;
  providers: { id: string; label: string }[];
  /** Confirmed by the server from session.provider_id, without exposing the session. */
  demoSession: boolean;
  /** Only supplied by a caller with confirmed owner authorization. */
  owner?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fn, setFn] = useState<ActorFunction>("medical_affairs");
  const [pickedRole, setPickedRole] = useState<Role>("medical_affairs");

  async function post(body: Record<string, unknown>, key: string) {
    setPending(key);
    setError(null);
    const url = body.action === "sign_out" ? "/api/auth/logout" : "/api/auth/login";
    const res = await postJson(url, body);
    const json = res.json as { error?: string; authorize_url?: string; redirect?: string };
    setPending(null);
    if (!res.ok) {
      setError(json.error ?? "Sign-in failed");
      return;
    }
    if (json.authorize_url || json.redirect) {
      window.location.href = json.authorize_url ?? json.redirect!;
      return;
    }
    router.refresh();
  }

  return (
    <section className="grid gap-3 border border-border bg-card p-3 rounded-lg" aria-labelledby="session">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="session" className="text-base font-semibold text-foreground">
            Session
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {actorName} · {ROLE_LABELS[role]}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {signedIn ? "Signed in" : "Unsigned"}
            {signedIn && demoSession ? " · Demo session" : !signedIn && demo ? " · Demo mode" : ""}
            {owner ? " · Owner" : ""}
          </p>
        </div>
        {signedIn ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => void post({ action: "sign_out" }, "out")}
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </Button>
        ) : null}
      </div>

      {!signedIn && providers.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              size="sm"
              disabled={pending !== null}
              onClick={() => void post({ provider_id: provider.id }, provider.id)}
            >
              {pending === provider.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogIn className="size-3.5" aria-hidden />
              )}
              Continue with {provider.label}
            </Button>
          ))}
        </div>
      ) : null}

      {!signedIn && DEMO_SIGN_IN ? (
        <details className="min-w-0 border-t border-border pt-3">
          <summary className="w-fit cursor-pointer rounded-sm text-[12px] font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            Developer tools
          </summary>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {demo ? "No identity provider is configured. In development you can continue as a demo user." : "Demo sign-in is available in development only."}
          </p>
          <form
            className="mt-3 grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void post(
                { demo: true, actor_name: name, actor_function: fn, role: pickedRole },
                "demo",
              );
            }}
          >
            <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
              Name
              <Input value={name} placeholder="Your name" onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
              Function
              <select
                className="h-8 min-w-0 max-w-full rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
                value={fn}
                onChange={(event) => setFn(event.target.value as ActorFunction)}
              >
                {ACTOR_FUNCTIONS.map((option) => (
                  <option key={option} value={option}>
                    {FUNCTION_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
              Role
              <select
                className="h-8 min-w-0 max-w-full rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
                value={pickedRole}
                onChange={(event) => setPickedRole(event.target.value as Role)}
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <Button className="h-auto min-h-8 whitespace-normal" size="sm" type="submit" variant="outline" disabled={pending !== null || !name.trim()}>
              Continue as a demo user (development only)
            </Button>
          </form>
        </details>
      ) : null}

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
