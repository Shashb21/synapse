"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, CircleDashed, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAiEnabled } from "@/components/platform/ai-status";

/** What the panel knows about a provider's key: whether it is set and where from. Never its value. */
export type ProviderKeyCardView = {
  provider_id: string;
  label: string;
  summary: string;
  tier: "default" | "alternate" | null;
  auth: "api_key" | "none";
  status: "configured" | "missing";
  /** The env var the server reads the key from; null for a provider that needs none. */
  key_env: string | null;
  models: string[];
  default_model: string;
};

const STATUS_COPY: Record<ProviderKeyCardView["status"], string> = {
  configured: "Key set",
  missing: "No key",
};

/**
 * Each provider's API-key status plus the locked one-click default switch. Keys
 * live in the server environment; there is no field anywhere here for one (KAN-65).
 */
export function ProviderPanel({
  connections,
  defaults,
  canRoute,
  routedTo = null,
}: {
  connections: ProviderKeyCardView[];
  defaults: { primary: string; alternate: string };
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
    const json = (await res.json()) as { error?: string };
    setBusy(null);
    if (!res.ok) {
      setError(json.error ?? "Action failed");
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
            Each provider uses an API key set in the server environment (.env.local or your host&apos;s
            settings). Keys are never shown or entered here.
          </p>
          {ai ? null : (
            <p className="mt-1 text-[12px] text-[var(--unknown-foreground)]" data-testid="providers-ai-off">
              AI is off, so no provider is called. Keys stay in place for when AI is turned back on.
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
          const configured = connection.status === "configured";
          const Icon = configured ? CircleCheck : CircleDashed;
          return (
            <article
              key={connection.provider_id}
              data-testid={`provider-card-${connection.provider_id}`}
              className={cn(
                "grid min-w-0 gap-2 border bg-card p-3 rounded-lg",
                configured ? "border-[var(--known)]/40" : "border-border",
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
                    configured ? "text-[var(--known-foreground)]" : "text-muted-foreground",
                  )}
                  aria-hidden
                />
              </div>

              <dl className="grid gap-1 text-[11px] text-muted-foreground">
                <div className="flex justify-between gap-2">
                  <dt>Status</dt>
                  <dd
                    className={configured ? "text-foreground" : "text-[var(--unknown-foreground)]"}
                    data-testid="provider-key-status"
                  >
                    {STATUS_COPY[connection.status]}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Default model</dt>
                  <dd className="truncate text-foreground">{connection.default_model}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Credential</dt>
                  <dd className="truncate text-foreground" data-testid="provider-key-env">
                    {connection.key_env ? (
                      <>
                        <code className="font-mono">{connection.key_env}</code> (server environment)
                      </>
                    ) : (
                      "none needed"
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
