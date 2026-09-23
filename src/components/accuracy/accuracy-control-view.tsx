import {
  AccuracyRoutingPanel,
  type AccuracyRouteView,
} from "@/components/accuracy/accuracy-routing-panel";
import { accuracyRouteConfigs, registerAccuracyStack } from "@/accuracy";
import { CALL_KINDS_META } from "@/accuracy/kernel/contracts";
import { PROVIDERS } from "@/modules/llm/provider";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";

registerAccuracyStack();

export async function AccuracyControlView() {
  const [configs, identity] = await Promise.all([accuracyRouteConfigs(), sessionContext()]);

  const routes: AccuracyRouteView[] = await Promise.all(
    configs.map(async (config) => {
      const meta = CALL_KINDS_META[config.call_kind];
      const agentic = meta.llm_roles.length > 0 && config.agent_role !== "none";
      return {
        call_kind: config.call_kind,
        call_kind_title: `${config.call_kind} · ${meta.title}`,
        agent_role: config.agent_role,
        kind: meta.kind,
        agentic,
        provider_id: config.provider_id,
        model: config.model,
        temperature: config.params.temperature,
        max_tokens: config.params.max_tokens,
        fallbacks: config.fallbacks,
        updated_by: config.updated_by,
        updated_at: config.updated_at,
      };
    }),
  );

  return (
    <AccuracyRoutingPanel
      routes={routes}
      providers={PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        models: provider.models,
        default_model: provider.default_model,
        auth: provider.auth,
      }))}
      canRoute={can(identity.role, "configure_routing")}
    />
  );
}
