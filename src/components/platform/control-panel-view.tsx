/** Owner control panel: confirmed configuration, independent availability, and safe recovery. */
import { AiAvailabilitySummary } from "./ai-availability-summary";
import { randomUUID } from "node:crypto";
import { ProviderPanel } from "@/components/platform/provider-panel";
import { RoutingPanel, type StageRouteView } from "@/components/platform/routing-panel";
import { SessionPanel } from "@/components/platform/session-panel";
import { AiSwitchPanel } from "@/components/platform/ai-switch-panel";
import { ConfigurationRecovery } from "@/components/platform/configuration-recovery";
import { loadControlPanel } from "@/components/platform/control-panel-load";
import { STAGES, STAGE_IDS } from "@/modules/kernel/contracts";
import { type RouteConfig } from "@/modules/kernel/routing";
import { listProviderKeys } from "@/modules/llm/api-keys";
import { ALTERNATE_ROUTE_PROVIDER, DEFAULT_ROUTE_PROVIDER, DEFAULT_ROUTE_FALLBACKS, PROVIDERS } from "@/modules/llm/provider";
import { loginOptions } from "@/modules/auth/session";

export { AI_OFF_OWNER_MESSAGE } from "@/components/platform/control-panel-load";

export type ControlPanelSearchParams = { signed_in?: string; sign_in_error?: string };

/** Read settings on the server; never substitute invented defaults for a failed source. */
export async function ControlPanelView({ params }: { params: ControlPanelSearchParams }) {
  const data = await loadControlPanel();
  const ai = data.master.status === "ready" ? data.master.value : null;
  const sections = data.sections.status === "ready" ? data.sections.value : null;
  const identity = data.identity.status === "ready" ? data.identity.value : null;
  const configs = data.configs.status === "ready" ? data.configs.value : null;
  // The control panel is owner-only. Unknown authorization never enables a mutation.
  const mayEdit = Boolean(identity && data.owner.status === "ready" && data.owner.value.owner);
  // Presence metadata only. A failed key read remains unknown, never missing.
  let keys: ReturnType<typeof listProviderKeys> | null = null;
  try { keys = listProviderKeys(); } catch { /* Do not expose credential-read errors. */ }
  const credentialProviders = keys?.map(key => ({ ...key, id: key.provider_id })) ?? null;
  const unavailable = [
    ...(keys ? [] : ["provider credentials"]),
    ...(ai ? [] : ["master AI switch"]),
    ...(sections ? [] : ["section switches"]),
    ...(configs && STAGE_IDS.every(stage => configs.some(row => row.stage === stage)) ? [] : ["saved routes"]),
    ...(data.wiring.status === "ready" && STAGE_IDS.every(stage => data.wiring.status === "ready" && data.wiring.value.some(row => row.stage === stage)) ? [] : ["module configuration"]),
    ...(identity ? [] : ["identity"]),
    ...(data.owner.status === "ready" ? [] : ["owner authorization"]),
    ...(STAGE_IDS.some(stage => STAGES[stage].kind === "agentic" && data.resolutions[stage].status === "unavailable") ? ["route previews"] : []),
  ];
  const routes: StageRouteView[] = STAGE_IDS.map(stage => {
    const config = configs?.find(row => row.stage === stage);
    const wired = data.wiring.status === "ready" ? data.wiring.value.find(row => row.stage === stage) : undefined;
    const resolution = data.resolutions[stage];
    return {
      stage, stage_title: `${stage} · ${STAGES[stage].title}`,
      config_available: Boolean(config), wiring_available: Boolean(wired),
      module_id: wired?.active?.id ?? null, module_version: wired?.active?.version ?? null,
      available_modules: wired?.available.map(manifest => ({ id: manifest.id, version: manifest.version, title: manifest.title })) ?? [],
      agentic: wired?.active?.agentic ?? STAGES[stage].kind === "agentic",
      provider_id: config?.provider_id ?? null, model: config?.model ?? null,
      temperature: config?.params.temperature ?? null, max_tokens: config?.params.max_tokens ?? null,
      fallbacks: config?.fallbacks ?? null, updated_by: config?.updated_by ?? null, updated_at: config?.updated_at ?? null,
      resolved_label: credentialProviders === null ? "Credential status unavailable" : resolution.status === "ready" ? resolution.value.label : null,
      degraded_reason: credentialProviders === null ? null : resolution.status === "ready" ? resolution.value.message : null,
      resolution_state: credentialProviders === null ? "unavailable" : resolution.status === "ready" ? resolution.value.state : "unavailable",
    };
  });

  return <>
    {params.signed_in ? <p className="mb-4 border border-[var(--known)]/40 bg-card p-2 text-[12px] text-foreground rounded-lg">Signed in as {params.signed_in}.</p> : null}
    {params.sign_in_error ? <p className="mb-4 border border-destructive/40 bg-card p-2 text-[12px] text-destructive rounded-lg">Sign-in failed. Please try signing in again.</p> : null}
    <div className="control-panel grid min-w-0 gap-8">
      {identity ? <SessionPanel actorName={identity.actor.name} role={identity.role} signedIn={identity.signed_in}
        demo={identity.demo} demoSession={identity.session?.provider_id === "demo"} owner={mayEdit} providers={loginOptions().providers} />
        : <p className="text-sm text-muted-foreground">Session details unavailable. Retry configuration to confirm your signed-in identity.</p>}
      <AiAvailabilitySummary input={{ master: ai?.enabled ?? null, sections, routes: configs, runtimeRoutes: data.runtimeConfigs.status === "ready" ? data.runtimeConfigs.value : null, providers: credentialProviders }} />
      <ConfigurationRecovery loadId={randomUUID()} unavailable={unavailable} />
      {!identity || data.owner.status === "unavailable" ? <p className="text-sm text-[var(--unknown-foreground)]">Owner authorization unavailable. Changes are disabled until your identity and owner access can be confirmed.</p> : null}
      <AiSwitchPanel ai={ai} sections={sections} mayToggle={mayEdit} identity={{
        signed_in: identity?.signed_in ?? false,
        actor_name: identity?.actor.name ?? "Identity unavailable",
        actor_function: identity?.actor.function ?? "medical_affairs",
      }} />
      {keys ? <ProviderPanel
        masterEnabled={ai?.enabled ?? null}
        connections={keys.map(key => ({ ...key, tier: key.tier ?? null }))}
        defaults={{ primary: DEFAULT_ROUTE_PROVIDER, alternate: ALTERNATE_ROUTE_PROVIDER, chain: [DEFAULT_ROUTE_PROVIDER, ...DEFAULT_ROUTE_FALLBACKS] }}
        canRoute={mayEdit}
        routesAvailable={Boolean(configs && STAGE_IDS.every(stage => configs.some(row => row.stage === stage)))}
        routingSnapshot={configs ? JSON.stringify(configs) : null}
        routingKnown={configs !== null}
        routedTo={configs ? routedToEveryStage(configs) : null}
      /> : <p id="providers" role="status">Provider credential status unavailable. Retry configuration to try again.</p>}
      <RoutingPanel credentials={credentialProviders} routes={routes} masterEnabled={ai?.enabled ?? null} providers={PROVIDERS.map(provider => ({
        id: provider.id, label: provider.label, models: provider.models, default_model: provider.default_model, auth: provider.auth,
        temperature_unsupported_models: provider.models.filter(model => provider.sendsTemperature?.(model) === false),
      }))} canRoute={mayEdit} canActivate={mayEdit} />
    </div>
  </>;
}

/** The provider every stage routes to, or null when they differ (KAN-60). */
export function routedToEveryStage(configs: Pick<RouteConfig, "provider_id">[]): string | null {
  const first = configs[0]?.provider_id;
  return first && configs.every(config => config.provider_id === first) ? first : null;
}
