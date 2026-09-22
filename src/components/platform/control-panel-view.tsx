import { ProviderPanel } from "@/components/platform/provider-panel";
import { RoutingPanel, type StageRouteView } from "@/components/platform/routing-panel";
import { SessionPanel } from "@/components/platform/session-panel";
import { STAGES, STAGE_IDS } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { resolveRoute, routeConfigs } from "@/modules/kernel/routing";
import { listConnections } from "@/modules/llm/oauth";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  PROVIDERS,
} from "@/modules/llm/provider";
import { capabilitiesOf, can } from "@/modules/auth/roles";
import { loginOptions, sessionContext } from "@/modules/auth/session";

export type ControlPanelSearchParams = {
  connected?: string;
  connect_error?: string;
  signed_in?: string;
  sign_in_error?: string;
};

/** OAuth control panel: five LLM providers, Grok default, Claude one-click, no API-key fields. */
export async function ControlPanelView({ params }: { params: ControlPanelSearchParams }) {
  const [wiring, configs, connections, identity] = await Promise.all([
    stageWiring(),
    routeConfigs(),
    listConnections(),
    sessionContext(),
  ]);
  const resolved = await Promise.all(STAGE_IDS.map((stage) => resolveRoute(stage)));

  const routes: StageRouteView[] = STAGE_IDS.map((stage, index) => {
    const config = configs.find((row) => row.stage === stage)!;
    const wired = wiring.find((row) => row.stage === stage)!;
    const route = resolved[index]!;
    return {
      stage,
      stage_title: `${stage} · ${STAGES[stage].title}`,
      module_id: wired.active?.id ?? null,
      module_version: wired.active?.version ?? null,
      available_modules: wired.available.map((manifest) => ({
        id: manifest.id,
        version: manifest.version,
        title: manifest.title,
      })),
      agentic: wired.active?.agentic ?? STAGES[stage].kind === "agentic",
      provider_id: config.provider_id,
      model: config.model,
      temperature: config.params.temperature,
      max_tokens: config.params.max_tokens,
      fallbacks: config.fallbacks,
      updated_by: config.updated_by,
      updated_at: config.updated_at,
      resolved_label: `${route.provider_label} · ${route.model}`,
      degraded_reason: route.degraded ? (route.reason ?? "degraded to a fallback") : null,
    };
  });

  return (
    <>
      {params.connected ? (
        <p className="mb-4 border border-[var(--known)]/40 bg-card/40 p-2 text-[12px] text-foreground">
          {params.connected} is connected.
        </p>
      ) : null}
      {params.connect_error ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          Connection failed: {params.connect_error}
        </p>
      ) : null}
      {params.signed_in ? (
        <p className="mb-4 border border-[var(--known)]/40 bg-card/40 p-2 text-[12px] text-foreground">
          Signed in as {params.signed_in}.
        </p>
      ) : null}
      {params.sign_in_error ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          Sign-in failed: {params.sign_in_error}
        </p>
      ) : null}

      <div className="grid gap-8">
        <SessionPanel
          actorName={identity.actor.name}
          role={identity.role}
          signedIn={identity.signed_in}
          demo={identity.demo}
          providers={loginOptions().providers}
          capabilities={capabilitiesOf(identity.role)}
        />

        <ProviderPanel
          connections={connections.map((connection) => ({
              provider_id: connection.provider_id,
              label: connection.label,
              summary: connection.summary,
              tier: connection.tier ?? null,
              auth: connection.auth,
              configured: connection.configured,
              status: connection.status,
              account_label: connection.account_label,
              connected_by: connection.connected_by,
              connected_at: connection.connected_at,
              detail: connection.detail,
              models: connection.models,
              default_model: connection.default_model,
            }))}
          defaults={{ primary: DEFAULT_ROUTE_PROVIDER, alternate: ALTERNATE_ROUTE_PROVIDER }}
          canConnect={can(identity.role, "connect_provider")}
          canRoute={can(identity.role, "configure_routing")}
        />

        <RoutingPanel
          routes={routes}
          providers={PROVIDERS.map((provider) => ({
              id: provider.id,
              label: provider.label,
              models: provider.models,
              default_model: provider.default_model,
              auth: provider.auth,
            }),
          )}
          canRoute={can(identity.role, "configure_routing")}
          canActivate={can(identity.role, "activate_module")}
        />
      </div>
    </>
  );
}
