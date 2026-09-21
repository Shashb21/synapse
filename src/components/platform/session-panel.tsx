"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, LogIn, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import { ROLES, ROLE_LABELS, ROLE_SUMMARIES, type Role } from "@/modules/auth/roles";

/**
 * Identity for the session. With an identity provider configured this is an
 * OAuth sign-in; with none, the typed-name gate the app already uses stands in.
 */
export function SessionPanel({
  actorName,
  role,
  signedIn,
  demo,
  providers,
  capabilities,
}: {
  actorName: string;
  role: Role;
  signedIn: boolean;
  demo: boolean;
  providers: { id: string; label: string }[];
  capabilities: string[];
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
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string; authorize_url?: string };
    setPending(null);
    if (!res.ok) {
      setError(json.error ?? "Sign-in failed");
      return;
    }
    if (json.authorize_url) {
      window.location.href = json.authorize_url;
      return;
    }
    router.refresh();
  }

  return (
    <section className="grid gap-3 border border-border bg-card/40 p-3" aria-labelledby="session">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="session" className="text-[15px] font-medium text-foreground">
            Who is acting
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {signedIn
              ? `${actorName} · ${ROLE_LABELS[role]}`
              : demo
                ? "No identity provider is configured, so this deployment runs in demo mode: the name you type on each gate is the actor."
                : "Sign in to act on the plan."}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{ROLE_SUMMARIES[role]}</p>
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

      <div className="flex flex-wrap gap-1">
        {capabilities.map((capability) => (
          <Badge key={capability} variant="secondary" className="text-[10px]">
            {capability.replaceAll("_", " ")}
          </Badge>
        ))}
      </div>

      {!signedIn && providers.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              size="sm"
              disabled={pending !== null}
              onClick={() => void post({ action: "sign_in_oauth", provider_id: provider.id }, provider.id)}
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

      {!signedIn && demo ? (
        <form
          className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void post(
              { action: "sign_in_demo", actor_name: name, actor_function: fn, role: pickedRole },
              "demo",
            );
          }}
        >
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Name
            <Input value={name} placeholder="Your name" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Function
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
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
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Role
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
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
          <Button size="sm" type="submit" variant="outline" disabled={pending !== null || !name.trim()}>
            Start session
          </Button>
        </form>
      ) : null}

      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
    </section>
  );
}
