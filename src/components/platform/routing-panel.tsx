"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAiEnabled } from "@/components/platform/ai-status";
import { postJson } from "@/lib/post-json";
import { credentialFeedback } from "./ai-availability";
import type { CredentialProvider } from "@/modules/kernel/credential-route";

export type ProviderOption = {
  id: string;
  label: string;
  models: string[];
  default_model: string;
  auth: "api_key" | "none";
  temperature_unsupported_models?: string[];
};

export type StageRouteView = {
  stage: string;
  stage_title: string;
  module_id: string | null;
  module_version: string | null;
  available_modules: { id: string; version: string; title: string }[];
  agentic: boolean;
  config_available?: boolean;
  wiring_available?: boolean;
  provider_id: string | null;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  fallbacks: string[] | null;
  updated_by: string | null;
  updated_at: string | null;
  resolved_label: string | null;
  resolution_state?: "resolved" | "fallback" | "no_provider" | "off" | "unavailable";
  degraded_reason: string | null;
};

/** Per-stage routing and module version. Changing one stage never touches another. */
export function RoutingPanel({
  routes,
  providers,
  canRoute,
  canActivate,
  credentials = null,
  aiKnown = true,
  masterEnabled,
}: {
  routes: StageRouteView[];
  masterEnabled?: boolean | null;
  providers: ProviderOption[];
  canRoute: boolean;
  canActivate: boolean;
  credentials?: CredentialProvider[] | null;
  aiKnown?: boolean;
}) {
  const inheritedAi = useAiEnabled();
  const ai = masterEnabled === undefined ? inheritedAi : masterEnabled;
  return (
    <section className="grid gap-3" aria-labelledby="routing">
      <div>
        <h2 id="routing" className="text-base font-semibold text-foreground">
          Per-stage routing
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Choose the provider and model for each AI stage. A provider needs a server API key;
          if neither it nor a fallback is available, the run stops and links back here.
        </p>
        {!aiKnown || ai === null ? <p className="mt-1 text-[12px] text-muted-foreground">Master AI state unavailable; whether saved routes are in use is unknown. Confirmed routes can still be edited.</p> : ai ? null : (
          <p className="mt-1 text-[12px] text-[var(--unknown-foreground)]" data-testid="routing-ai-off">
            AI is off, so these routes are not used. You can still edit them; they take effect when
            an admin turns AI back on.
          </p>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {routes.map((route) => (
          <StageRouteCard
            key={route.stage}
            route={route}
            providers={providers}
            credentials={credentials}
            canRoute={canRoute && route.config_available !== false}
            canActivate={canActivate && route.wiring_available !== false}
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
  credentials = null,
}: {
  route: StageRouteView;
  providers: ProviderOption[];
  canRoute: boolean;
  canActivate: boolean;
  credentials?: CredentialProvider[] | null;
}) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(route.provider_id ?? "");
  const [model, setModel] = useState(route.model ?? "");
  const [temperature, setTemperature] = useState(route.temperature === null ? "" : String(route.temperature));
  const [maxTokens, setMaxTokens] = useState(route.max_tokens === null ? "" : String(route.max_tokens));
  const [fallbacks, setFallbacks] = useState<string[]>(route.fallbacks ?? []);
  const [backupToAdd, setBackupToAdd] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Compare stored values, not object identity: an unrelated refresh keeps drafts.
  const persisted = JSON.stringify([
    route.provider_id, route.model, route.temperature, route.max_tokens,
    route.fallbacks, route.updated_at,
  ]);
  const [previousPersisted, setPreviousPersisted] = useState(persisted);
  // Unknown saved settings retire confirmations, while the editable draft survives recovery.
  if (route.config_available === false && saved !== null) setSaved(null);
  if (route.config_available !== false && previousPersisted !== persisted) {
    setPreviousPersisted(persisted);
    setProviderId(route.provider_id ?? "");
    setModel(route.model ?? "");
    setTemperature(String(route.temperature));
    setMaxTokens(String(route.max_tokens));
    setFallbacks(route.fallbacks ?? []);
    setBackupToAdd("");
    setError(null);
    if (providerId !== route.provider_id || model !== route.model ||
        temperature !== String(route.temperature) || maxTokens !== String(route.max_tokens) ||
        JSON.stringify(fallbacks) !== JSON.stringify(route.fallbacks ?? [])) setSaved(null);
  }

  function clearFeedback() {
    setSaved(null);
    setError(null);
  }

  const allowedProviders = providers.filter(candidate => candidate.auth === "api_key");
  const provider = allowedProviders.find((candidate) => candidate.id === providerId);
  const models = provider?.models ?? [];
  const invalidPrimary = Boolean(providerId && !provider);
  const invalidModel = Boolean(model && !models.includes(model));
  const backupIssues = fallbacks.map((id, index) => {
    if (!allowedProviders.some(candidate => candidate.id === id)) return "Unknown or disallowed provider. Remove this backup and choose an available provider.";
    if (id === providerId) return "This backup is also the primary provider. Remove it or choose a different primary provider.";
    if (fallbacks.indexOf(id) !== index) return "Duplicate backup. Remove this repeated entry.";
    return null;
  });
  const invalidRoute = invalidPrimary || invalidModel || backupIssues.some(Boolean);
  const availableBackups = allowedProviders.filter(candidate => candidate.id !== providerId && !fallbacks.includes(candidate.id));
  const selectedBackup = availableBackups.some(candidate => candidate.id === backupToAdd) ? backupToAdd : "";

  /** Move one backup without changing any other saved choices. */
  function moveBackup(index: number, direction: -1 | 1) {
    const next = [...fallbacks];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setFallbacks(next);
    clearFeedback();
  }


  const readiness = credentialFeedback({ provider_id: providerId, model, fallbacks }, credentials);

  async function save() {
    if (!canRoute || pending || invalidRoute) return;
    setPending(true);
    setError(null);
    setSaved(null);
    const res = await postJson("/api/control", {
        action: "set_route",
        stage: route.stage,
        provider_id: providerId,
        model,
        // Sent as typed: the server checks the bounds, keeps a blank number's
        // current value; the explicit backup array preserves order and empty chains.
        temperature,
        max_tokens: maxTokens,
        fallbacks,
      });
    const json = res.json as {
      error?: string;
      config?: { params: { temperature: number; max_tokens: number }; fallbacks: string[] };
    };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "We couldn’t confirm the AI preferences. Refresh configuration to check saved settings before saving again.");
      return;
    }
    // Show what was stored: a blank number comes back as the value it kept.
    if (json.config) {
      setTemperature(String(json.config.params.temperature));
      setMaxTokens(String(json.config.params.max_tokens));
      setFallbacks(json.config.fallbacks);
    }
    setSaved("Saved preferences.");
    router.refresh();
  }

  async function activate(moduleId: string) {
    if (!canActivate) return;
    clearFeedback();
    setPending(true);
    const res = await postJson("/api/control", { action: "activate_module", stage: route.stage, module_id: moduleId });
    const json = res.json as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "We couldn’t confirm the active implementation. Refresh configuration before changing it again.");
      return;
    }
    setSaved("Active implementation updated.");
    router.refresh();
  }

  return (
    <article className="grid min-w-0 content-start gap-3 border border-border bg-card p-3 rounded-lg">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-foreground">{route.stage_title.startsWith(`${route.stage} · `) ? route.stage_title.slice(route.stage.length + 3) : route.stage_title}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{route.stage}</p>
          {route.agentic || route.wiring_available === false ? <p className="mt-0.5 break-all text-[11px] text-muted-foreground">
            {route.wiring_available === false ? "Module configuration unavailable. Retry before changing the active implementation." : route.module_id ?? "no module registered"}
            {route.agentic && route.module_version ? ` · v${route.module_version}` : ""}
          </p> : null}
        </div>
        <Badge variant="outline" className="text-[10px]">
          {route.agentic ? "Uses AI" : "Does not use AI"}
        </Badge>
      </div>

      {route.agentic && route.config_available === false ? <p className="text-sm text-[var(--unknown-foreground)]">Saved route unavailable. Retry configuration before saving this stage. Existing unsaved edits are kept.</p> : null}
      {route.agentic ? <p className="break-words text-[12px] text-muted-foreground">
        {route.resolution_state === "unavailable"
          ? "Route preview unavailable. Retry configuration to confirm which provider can run this stage."
          : <>{route.resolved_label ? <>Resolves to <span className="text-foreground">{route.resolved_label}</span>. </> : null}{route.resolution_state === "fallback" ? "The preferred provider is unavailable. Check its credentials and model here before restoring it." : route.resolution_state === "no_provider" ? "No provider is ready. Add a provider credential and select a compatible model here." : route.resolution_state === "off" ? "AI is off for this task. Enable it here when you are ready to use AI." : null}</>}
      </p> : null}

      {route.agentic ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2" onChange={clearFeedback}>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Provider
            <select
              className="h-11 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
              value={providerId}
              disabled={!canRoute || pending}
              onChange={(event) => {
                const next = event.target.value;
                setProviderId(next);
                const picked = providers.find((candidate) => candidate.id === next);
                if (picked) setModel(picked.default_model);
              }}
            >
              {invalidPrimary ? <option value={providerId}>{providerId} — unavailable</option> : null}
              {!providerId ? <option value="" disabled>Unavailable — retry configuration</option> : null}
              {allowedProviders.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Model
            <select
              className="h-11 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
              value={model}
              disabled={!canRoute || pending}
              onChange={(event) => setModel(event.target.value)}
            >
              {invalidModel ? <option value={model}>{model} — unavailable</option> : null}
              {!model ? <option value="" disabled>Unavailable — retry configuration</option> : null}
              {models.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          {invalidPrimary || invalidModel ? <p role="alert" className="text-[12px] text-destructive sm:col-span-2">{invalidPrimary ? "Unknown or disallowed provider. Choose an available provider." : "Saved model is unavailable for this provider. Choose an available model."}</p> : null}
          {backupIssues.some(Boolean) ? <p role="alert" className="text-[12px] text-destructive sm:col-span-2">Backup configuration needs correction. Open Advanced routing settings to review and remove invalid entries before saving.</p> : null}
          <details className="min-w-0 sm:col-span-2">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring">Advanced routing settings</summary>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                Temperature (0 to 2)
                <Input
                  value={temperature}
                  inputMode="decimal"
                  placeholder="Blank keeps the current value"
                  disabled={!canRoute || pending}
                  onChange={(event) => setTemperature(event.target.value)}
                />
                <span>Answer variation: lower values give more consistent answers; higher values allow more variation. Blank keeps the current value.</span>
                {provider?.temperature_unsupported_models?.includes(model) ? <span>This model does not accept temperature; the adapter omits it from requests. The saved value is kept for other models.</span> : null}
              </label>
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                Maximum response tokens (1 to 200,000)
                <Input
                  value={maxTokens}
                  inputMode="numeric"
                  placeholder="Blank keeps the current value"
                  disabled={!canRoute || pending}
                  onChange={(event) => setMaxTokens(event.target.value)}
                />
              </label>
              <p className="text-[11px] text-muted-foreground sm:col-span-2">Output limit: tokens are small pieces of text, not words. Some models also count reasoning toward this limit. Provider limits may be lower; a stage may request its own output budget. Blank keeps the current value.</p>
              <fieldset className="grid min-w-0 gap-2 sm:col-span-2">
                <legend className="text-sm font-medium text-foreground">Backup providers, in order</legend>
                <p className="text-[12px] text-muted-foreground">The first available provider is used, in this order, with its default model. Each provider needs a server API key.</p>
                {fallbacks.length === 0 ? <p className="text-[12px] text-muted-foreground">No backup provider; the stage fails if the chosen provider cannot run</p> : null}
                <ol className="grid min-w-0 gap-2">
                  {fallbacks.map((id, index) => {
                    const label = allowedProviders.find(candidate => candidate.id === id)?.label ?? id;
                    return <li key={`${index}:${id}`} className="grid min-w-0 gap-1">
                      <span className="break-words text-sm text-foreground">{index + 1}. {label}</span>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="min-h-11" aria-label={`Move backup ${index + 1}: ${label} up`} disabled={!canRoute || pending || index === 0} onClick={() => moveBackup(index, -1)}>Move up</Button>
                        <Button size="sm" variant="outline" className="min-h-11" aria-label={`Move backup ${index + 1}: ${label} down`} disabled={!canRoute || pending || index === fallbacks.length - 1} onClick={() => moveBackup(index, 1)}>Move down</Button>
                        <Button size="sm" variant="outline" className="min-h-11" aria-label={`Remove backup ${index + 1}: ${label}`} disabled={!canRoute || pending} onClick={() => { setFallbacks(fallbacks.filter((_, position) => position !== index)); clearFeedback(); }}>Remove</Button>
                      </div>
                      {backupIssues[index] ? <p role="alert" className="break-words text-[12px] text-destructive">{backupIssues[index]}</p> : null}
                    </li>;
                  })}
                </ol>
                <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
                  Backup provider to add
                  <select aria-label="Backup provider to add" value={selectedBackup} disabled={!canRoute || pending || availableBackups.length === 0} className="h-11 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:text-sm" onChange={event => setBackupToAdd(event.target.value)}>
                    <option value="">{availableBackups.length ? "Choose a provider" : "No more providers available"}</option>
                    {availableBackups.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="outline" className="min-h-11 justify-self-start" disabled={!canRoute || pending || !selectedBackup} onClick={() => { setFallbacks([...fallbacks, selectedBackup]); setBackupToAdd(""); clearFeedback(); }}>Add backup</Button>
              </fieldset>
            </div>
          </details>
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
            className="h-11 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
            aria-label="Active implementation"
            value={route.module_id ?? ""}
            disabled={!canActivate || pending}
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

      {route.agentic ? <p data-testid="route-credential-readiness" className="break-words text-[12px] text-muted-foreground">{readiness}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {route.agentic ? (
          <Button className="min-h-11" size="sm" variant="outline" disabled={!canRoute || pending || invalidRoute} onClick={() => void save()}>
            {pending ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            Save route
          </Button>
        ) : null}
        {route.agentic || saved || pending ? <span role="status" className="text-[12px] text-muted-foreground">
          {saved ? `${saved}${saved === "Saved preferences." ? ` ${readiness}` : ""}` : (pending ? "Saving…" : route.config_available === false ? "Saved route unavailable" : `Last set by ${route.updated_by}`)}
        </span> : null}

      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </article>
  );
}
