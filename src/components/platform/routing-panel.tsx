"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ProviderOption = {
  id: string;
  label: string;
  models: string[];
  default_model: string;
  auth: "oauth" | "none";
};

export type StageRouteView = {
  stage: string;
  stage_title: string;
  module_id: string | null;
  module_version: string | null;
  available_modules: { id: string; version: string; title: string }[];
  agentic: boolean;
  provider_id: string;
  model: string;
  temperature: number;
  max_tokens: number;
  fallbacks: string[];
  updated_by: string;
  updated_at: string;
  resolved_label: string;
  degraded_reason: string | null;
};

/** Per-stage routing and module version. Changing one stage never touches another. */
export function RoutingPanel({
  routes,
  providers,
  canRoute,
  canActivate,
}: {
  routes: StageRouteView[];
  providers: ProviderOption[];
  canRoute: boolean;
  canActivate: boolean;
}) {
  return (
    <section className="grid gap-3" aria-labelledby="routing">
      <div>
        <h2 id="routing" className="text-[15px] font-medium text-foreground">
          Per-stage routing
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Each stage resolves its own provider, model and parameters. If the preferred provider is not
          logged in, the run degrades along the fallbacks and says so in the trace.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {routes.map((route) => (
          <StageRouteCard
            key={route.stage}
            route={route}
            providers={providers}
            canRoute={canRoute}
            canActivate={canActivate}
          />
        ))}
      </div>
    </section>
  );
}

function StageRouteCard({
  route,
  providers,
  canRoute,
  canActivate,
}: {
  route: StageRouteView;
  providers: ProviderOption[];
  canRoute: boolean;
  canActivate: boolean;
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
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_route",
        stage: route.stage,
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

  async function activate(moduleId: string) {
    setError(null);
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate_module", stage: route.stage, module_id: moduleId }),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? "Could not activate that module");
      return;
    }
    router.refresh();
  }

  return (
    <article className="grid gap-2 border border-border bg-card/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-foreground">{route.stage_title}</h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {route.module_id ?? "no module registered"}
            {route.module_version ? ` · v${route.module_version}` : ""}
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {route.agentic ? "agentic" : "mechanical"}
        </Badge>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Resolves to <span className="text-foreground">{route.resolved_label}</span>
        {route.degraded_reason ? ` · ${route.degraded_reason}` : ""}
      </p>

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
          This stage does not call a model, so it has no route to configure.
        </p>
      )}

      {route.available_modules.length > 1 ? (
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Active implementation
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
            value={route.module_id ?? ""}
            disabled={!canActivate}
            onChange={(event) => void activate(event.target.value)}
          >
            {route.available_modules.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title} · v{option.version}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="flex items-center gap-2">
        {route.agentic ? (
          <Button size="sm" variant="outline" disabled={!canRoute || pending} onClick={() => void save()}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save route
          </Button>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          {saved ? "Saved." : `Last set by ${route.updated_by}`}
        </span>
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </article>
  );
}
