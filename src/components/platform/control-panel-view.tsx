import { ProviderPanel } from "@/components/platform/provider-panel";
import { RoutingPanel, type StageRouteView } from "@/components/platform/routing-panel";
import { SessionPanel } from "@/components/platform/session-panel";
import { AiSwitchPanel } from "@/components/platform/ai-switch-panel";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { aiSwitch, storedAiSections, type AiSwitch } from "@/modules/kernel/ai-switch";
import { AiAvailabilitySummary } from "./ai-availability-summary";
import { selectCredentialRoute } from "@/modules/kernel/credential-route";
import { STAGES, STAGE_IDS } from "@/modules/kernel/contracts";
import { stageWiring, type StageWiring } from "@/modules/kernel/registry";
import { routeConfigs, type RouteConfig } from "@/modules/kernel/routing";
import { listProviderKeys } from "@/modules/llm/api-keys";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  DEFAULT_ROUTE_FALLBACKS,
  PROVIDERS,
} from "@/modules/llm/provider";
import { capabilitiesOf, can } from "@/modules/auth/roles";
import { loginOptions, sessionContext } from "@/modules/auth/session";
import { ownerAccess } from "@/modules/auth/owner";

export type ControlPanelSearchParams = {
  signed_in?: string;
  sign_in_error?: string;
};

/** Owner control panel (/admin/control): the AI switch, provider key status and per-stage routing. Five LLM providers, Grok default, Claude one-click; keys come from the server environment and are never shown or entered here. */
export async function ControlPanelView({ params }: { params: ControlPanelSearchParams }) {
  // Each read retains its own unknown state: one failure must not hide successful reads.
  const [wiringRead, configRead, identityRead, aiRead, sectionsRead] = await Promise.allSettled([
    stageWiring(), routeConfigs(), sessionContext(), aiSwitch(), storedAiSections(),
  ]);
  const wiring: StageWiring[] | null = wiringRead.status === "fulfilled" ? wiringRead.value : null;
  const configs: RouteConfig[] | null = configRead.status === "fulfilled" ? configRead.value : null;
  const ai: AiSwitch | null = aiRead.status === "fulfilled" ? aiRead.value : null;
  const sections = sectionsRead.status === "fulfilled" ? sectionsRead.value.sections : null;
  const identity = identityRead.status === "fulfilled" ? identityRead.value : {
    session: null,
    actor: { name: "Unsigned (demo)", function: "medical_affairs" as const },
    role: "medical_affairs" as const, demo: true, signed_in: false,
  };
  // Presence metadata only; never send credentials or exception messages to the browser.
  let keys: ReturnType<typeof listProviderKeys> | null = null;
  try { keys = listProviderKeys(); } catch { /* Unknown remains explicit in the summary. */ }
  const credentialProviders = keys?.map(key => ({ ...key, id: key.provider_id })) ?? null;
  // The owner holds every platform capability, whatever their plan role.
  const owner = (await ownerAccess()).owner;
  const may = (capability: Parameters<typeof can>[1]) => owner || can(identity.role, capability);

  const routes: StageRouteView[] = configs && wiring ? STAGE_IDS.flatMap((stage) => {
    const config = configs.find((row) => row.stage === stage);
    const wired = wiring.find((row) => row.stage === stage);
    if (!config || !wired) return [];
    const selected = credentialProviders ? selectCredentialRoute(config, credentialProviders).selected : null;
    return [{
      stage,
      stage_title: `${stage} · ${STAGES[stage].title}`,
      module_id: wired.active?.id ?? null,
      module_version: wired.active?.version ?? null,
      available_modules: wired.available.map((manifest) => ({ id: manifest.id, version: manifest.version, title: manifest.title })),
      agentic: wired.active?.agentic ?? STAGES[stage].kind === "agentic",
      provider_id: config.provider_id,
      model: config.model,
      temperature: config.params.temperature,
      max_tokens: config.params.max_tokens,
      fallbacks: config.fallbacks,
      updated_by: config.updated_by,
      updated_at: config.updated_at,
      resolved_label: credentialProviders === null ? "Credential status unavailable"
        : selected ? `${selected.provider.label} · ${selected.model}` : "No configured provider",
      degraded_reason: ai === null ? "Master switch status unavailable."
        : !ai.enabled ? AI_OFF_OWNER_MESSAGE
        : !credentialProviders ? "Credential status unavailable."
        : selected?.fallback ? "Primary key missing; a configured fallback would be used."
        : selected ? null : "Set a permitted provider's API key in the server environment.",
    }];
  }) : [];

  return (
    <>
      {params.signed_in ? (
        <p className="mb-4 border border-[var(--known)]/40 bg-card p-2 text-[12px] text-foreground rounded-lg">
          Signed in as {params.signed_in}.
        </p>
      ) : null}
      {params.sign_in_error ? (
        <p className="mb-4 border border-destructive/40 bg-card p-2 text-[12px] text-destructive rounded-lg">
          Sign-in failed. Please try signing in again.
        </p>
      ) : null}

      <div className="control-panel grid min-w-0 gap-8">
        <AiAvailabilitySummary input={{ master: ai?.enabled ?? null, sections, routes: configs, providers: credentialProviders }} />
        {ai && sections ? <AiSwitchPanel
          ai={ai}
          sections={sections}
          mayToggle={may("toggle_ai")}
          identity={{
            signed_in: identity.signed_in,
            actor_name: identity.actor.name,
            actor_function: identity.actor.function,
          }}
        /> : <p id="ai-switch" role="status" className="text-sm text-muted-foreground">AI settings unavailable. Refresh to try again.</p>}

        {/* Providers and routes follow the master switch, not the owner's open workspace. */}
        <AiStatusProvider enabled={ai?.enabled ?? false} offBy={ai?.enabled ? null : "platform"}>
        {keys ? <ProviderPanel
          connections={keys.map((key) => ({ ...key, tier: key.tier ?? null }))}
          defaults={{ primary: DEFAULT_ROUTE_PROVIDER, alternate: ALTERNATE_ROUTE_PROVIDER, chain: [DEFAULT_ROUTE_PROVIDER, ...DEFAULT_ROUTE_FALLBACKS] }}
          canRoute={may("configure_routing")}
          routedTo={configs ? routedToEveryStage(configs) : null}
          routingSnapshot={configs ? JSON.stringify(configs) : null}
          routingKnown={configs !== null}
          aiKnown={ai !== null}
        /> : <p id="providers" role="status">Provider credential status unavailable. Refresh to try again.</p>}

        {configs && wiring ? <RoutingPanel
          routes={routes}
          providers={PROVIDERS.map((provider) => ({
              id: provider.id,
              label: provider.label,
              models: provider.models,
              default_model: provider.default_model,
              auth: provider.auth,
            }),
          )}
          credentials={credentialProviders}
          aiKnown={ai !== null}
          canRoute={may("configure_routing")}
          canActivate={may("activate_module")}
        /> : <p id="routing" role="status">Routing configuration unavailable. Refresh to try again.</p>}
        </AiStatusProvider>
        <SessionPanel
          actorName={identity.actor.name}
          role={identity.role}
          signedIn={identity.signed_in}
          demo={identity.demo}
          providers={loginOptions().providers}
          capabilities={capabilitiesOf(identity.role)}
        />
      </div>
    </>
  );
}

/** Why a route is idle while the master switch is off, worded for the owner. */
export const AI_OFF_OWNER_MESSAGE = "AI is off platform-wide. Turn it on above.";

/** The provider every stage routes to, or null when they differ (KAN-60). */
export function routedToEveryStage(configs: Pick<RouteConfig, "provider_id">[]): string | null {
  const first = configs[0]?.provider_id;
  return first && configs.every((config) => config.provider_id === first) ? first : null;
}
