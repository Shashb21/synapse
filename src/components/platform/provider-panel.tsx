"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, CircleDashed, Loader2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAiEnabled } from "@/components/platform/ai-status";

export type ProviderConnectionView = {
  provider_id: string;
  label: string;
  summary: string;
  tier: "default" | "alternate" | null;
  auth: "oauth" | "none";
  configured: boolean;
  status: "disconnected" | "pending" | "connected" | "error";
  account_label: string | null;
  connected_by: string | null;
  connected_at: string | null;
  detail: string | null;
  models: string[];
  default_model: string;
};

const STATUS_COPY: Record<ProviderConnectionView["status"], string> = {
  connected: "Connected",
  pending: "Authorization started",
  disconnected: "Not connected",
  error: "Needs attention",
};

/**
 * Per-provider OAuth login plus the locked one-click default switch. There is no
 * field anywhere here for pasting an API key.
 */
export function ProviderPanel({
  connections,
  defaults,
  canConnect,
  canRoute,
  routedTo = null,
}: {
  connections: ProviderConnectionView[];
  defaults: { primary: string; alternate: string };
  canConnect: boolean;
  canRoute: boolean;
  /** The provider every stage routes to; null when stages use a mix (KAN-60). */
  routedTo?: string | null;
}) {
  const ai = useAiEnabled();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, key: string, done?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string; authorize_url?: string };
    setBusy(null);
    if (!res.ok) {
      setError(json.error ?? "Action failed");
      return;
    }
    if (json.authorize_url) {
      window.location.assign(json.authorize_url);
      return;
    }
    if (done) setNotice(done);
    router.refresh();
  }

  const primary = connections.find((connection) => connection.provider_id === defaults.primary);
  const alternate = connections.find((connection) => connection.provider_id === defaults.alternate);

  return (
    <section className="grid gap-3" aria-labelledby="providers">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="providers" className="text-[13px] font-semibold text-foreground">
            LLM providers
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Every provider is reached by OAuth login. Synapse never asks you for an API key.
          </p>
          {ai ? null : (
            <p className="mt-1 text-[12px] text-[var(--unknown-foreground)]" data-testid="providers-ai-off">
              AI is off, so no provider is called. Connections are kept for when AI is turned back on.
            </p>
          )}
        </div>
        {canRoute ? (
          <div className="grid justify-items-end gap-1">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Route every stage to">
              <span className="text-[11px] text-muted-foreground">Route every stage to</span>
              {[
                { connection: primary, id: defaults.primary, fallback: "Grok", key: "switch-primary" },
                { connection: alternate, id: defaults.alternate, fallback: "Claude", key: "switch-alternate" },
              ].map((choice) => {
                const label = choice.connection?.label ?? choice.fallback;
                const active = routedTo === choice.id;
                return (
                  <Button
                    key={choice.key}
                    size="sm"
                    variant={active ? "default" : "outline"}
                    aria-pressed={active}
                    disabled={busy !== null}
                    onClick={() =>
                      void post(
                        { action: "set_default_provider", provider_id: choice.id },
                        choice.key,
                        `Every stage now routes to ${label}.`,
                      )
                    }
                  >
                    {busy === choice.key ? <Loader2 className="size-3.5 animate-spin" /> : active ? <CircleCheck className="size-3.5" aria-hidden /> : null}
                    {label}
                  </Button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground" data-testid="providers-routed-to">
              {routedTo
                ? `Every stage routes to ${connections.find((connection) => connection.provider_id === routedTo)?.label ?? routedTo}.`
                : "Stages use a mix of providers. See Routing below."}
            </p>
          </div>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="text-[12px] text-[var(--known-foreground)]">
          {notice}
        </p>
      ) : null}
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {connections.map((connection) => {
          const connected = connection.status === "connected";
          const Icon =
            connection.status === "connected"
              ? CircleCheck
              : connection.status === "error"
                ? TriangleAlert
                : CircleDashed;
          return (
            <article
              key={connection.provider_id}
              className={cn(
                "grid min-w-0 gap-2 border bg-card p-3 rounded-lg",
                connected ? "border-[var(--known)]/40" : "border-border",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-[12px] font-semibold text-foreground">{connection.label}</h3>
                    {routedTo === connection.provider_id ? (
                      <Badge className="text-[10px]" data-testid="provider-routing-every-stage">
                        Routing every stage
                      </Badge>
                    ) : null}
                    {connection.tier === "default" ? (
                      <Badge variant="outline" className="border-[var(--chart-1)]/50 text-[10px]">
                        Default route
                      </Badge>
                    ) : connection.tier === "alternate" ? (
                      <Badge variant="outline" className="border-[var(--chart-3)]/50 text-[10px]">
                        One-click alternate
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{connection.summary}</p>
                </div>
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    connected ? "text-[var(--known-foreground)]" : connection.status === "error" ? "text-destructive" : "text-muted-foreground",
                  )}
                  aria-hidden
                />
              </div>

              <dl className="grid gap-1 text-[11px] text-muted-foreground">
                <div className="flex justify-between gap-2">
                  <dt>Status</dt>
                  <dd className="text-foreground">{STATUS_COPY[connection.status]}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Default model</dt>
                  <dd className="truncate text-foreground">{connection.default_model}</dd>
                </div>
                {connection.auth === "oauth" ? (
                  <div className="flex justify-between gap-2">
                    <dt>OAuth client</dt>
                    <dd className={connection.configured ? "text-foreground" : "text-[var(--unknown-foreground)]"}>
                      {connection.configured ? "built-in (PKCE)" : "unavailable"}
                    </dd>
                  </div>
                ) : null}
                {connection.connected_by ? (
                  <div className="flex justify-between gap-2">
                    <dt>Signed in by</dt>
                    <dd className="truncate text-foreground">{connection.connected_by}</dd>
                  </div>
                ) : null}
              </dl>

              {connection.detail ? (
                <p className="break-all text-[11px] text-amber-800 dark:text-amber-300">{connection.detail}</p>
              ) : null}

              {connection.auth === "oauth" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={connected ? "outline" : "default"}
                    disabled={!canConnect || busy !== null}
                    onClick={() =>
                      void post(
                        { action: "connect_provider", provider_id: connection.provider_id },
                        connection.provider_id,
                      )
                    }
                  >
                    {busy === connection.provider_id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {connected ? "Re-authorize" : `Log in with ${connection.label.split(" · ")[0]}`}
                  </Button>
                  {connection.status !== "disconnected" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canConnect || busy !== null}
                      onClick={() =>
                        void post(
                          { action: "disconnect_provider", provider_id: connection.provider_id },
                          `${connection.provider_id}-off`,
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
