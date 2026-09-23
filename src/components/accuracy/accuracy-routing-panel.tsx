"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderOption } from "@/components/platform/routing-panel";

export type AccuracyRouteView = {
  call_kind: string;
  call_kind_title: string;
  agent_role: string;
  kind: string;
  agentic: boolean;
  provider_id: string;
  model: string;
  temperature: number;
  max_tokens: number;
  fallbacks: string[];
  updated_by: string;
  updated_at: string;
};

export function AccuracyRoutingPanel({
  routes,
  providers,
  canRoute,
}: {
  routes: AccuracyRouteView[];
  providers: ProviderOption[];
  canRoute: boolean;
}) {
  return (
    <section className="grid gap-3" aria-labelledby="accuracy-routing">
      <div>
        <h2 id="accuracy-routing" className="text-[15px] font-medium text-foreground">
          Per call kind · per agent role
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Each LLM role on an agentic call kind resolves its own provider, model, and parameters.
          Mechanical kinds have no routable role.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {routes.map((route) => (
          <AccuracyRouteCard
            key={`${route.call_kind}:${route.agent_role}`}
            route={route}
            providers={providers}
            canRoute={canRoute}
          />
        ))}
      </div>
    </section>
  );
}

function AccuracyRouteCard({
  route,
  providers,
  canRoute,
}: {
  route: AccuracyRouteView;
  providers: ProviderOption[];
  canRoute: boolean;
}) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(route.provider_id);
  const [model, setModel] = useState(route.model);
  const [temperature, setTemperature] = useState(String(route.temperature));
  const [maxTokens, setMaxTokens] = useState(String(route.max_tokens));
  const [fallbacks, setFallbacks] = useState(route.fallbacks.join(", "));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const provider = providers.find((candidate) => candidate.id === providerId);
  const models = provider?.models ?? [route.model];

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/accuracy/routing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_route",
        call_kind: route.call_kind,
        agent_role: route.agent_role,
        provider_id: providerId,
        model,
        temperature: Number(temperature),
        max_tokens: Number(maxTokens),
        fallbacks,
      }),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Could not save this route");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  const title =
    route.agent_role === "none"
      ? route.call_kind_title
      : `${route.call_kind_title} · ${route.agent_role}`;

  return (
    <article className="grid gap-2 border border-border bg-card/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{route.call_kind}</p>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {route.kind}
        </Badge>
      </div>

      {route.agentic ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Provider
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
              value={providerId}
              disabled={!canRoute}
              onChange={(event) => {
                const next = event.target.value;
                setProviderId(next);
                const picked = providers.find((candidate) => candidate.id === next);
                if (picked) setModel(picked.default_model);
              }}
            >
              {providers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Model
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
              value={model}
              disabled={!canRoute}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Temperature
            <Input
              value={temperature}
              disabled={!canRoute}
              onChange={(event) => setTemperature(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Max tokens
            <Input
              value={maxTokens}
              disabled={!canRoute}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground sm:col-span-2">
            Fallbacks, in order
            <Input
              value={fallbacks}
              disabled={!canRoute}
              onChange={(event) => setFallbacks(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          This call kind does not invoke an LLM for this role.
        </p>
      )}

      <div className="flex items-center gap-2">
        {route.agentic ? (
          <Button size="sm" variant="outline" disabled={!canRoute || pending} onClick={() => void save()}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save route
          </Button>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          {saved ? "Saved." : `Last set by ${route.updated_by} · ${route.updated_at}`}
        </span>
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </article>
  );
}
