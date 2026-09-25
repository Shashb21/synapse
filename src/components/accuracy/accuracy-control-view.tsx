import {
  AccuracyRoutingPanel,
  type AccuracyRouteView,
} from "@/components/accuracy/accuracy-routing-panel";
import { accuracyRouteConfigs, listModelPrices, registerAccuracyStack } from "@/accuracy";
import { CALL_KINDS_META } from "@/accuracy/kernel/contracts";
import { PROVIDERS } from "@/modules/llm/provider";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { aiSwitch } from "@/modules/kernel/ai-switch";
import Link from "next/link";

registerAccuracyStack();

export async function AccuracyControlView() {
  const [configs, identity, ai] = await Promise.all([
    accuracyRouteConfigs(),
    sessionContext(),
    aiSwitch(),
  ]);

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
    <div className="grid gap-8">
      <section
        className="grid gap-1 border border-border bg-card/40 p-3"
        aria-labelledby="ai-switch-state"
        data-testid="accuracy-ai-switch-state"
      >
        <h2 id="ai-switch-state" className="text-[15px] font-medium text-foreground">
          AI switch · {ai.enabled ? "on" : "off"}
        </h2>
        <p className="text-[12px] text-muted-foreground">
          {ai.enabled
            ? "Models run on the routes below (parse, extract, audit, coverage assist, ideate)."
            : "AI is off: no route below is called. Every accuracy step is done by hand — add gaps and tactics on the Ledger, decide coverage, set priority and dates yourself."}
          {ai.updated_by ? ` Last changed by ${ai.updated_by}` : ""}
          {ai.updated_at ? ` at ${ai.updated_at}` : ""}
          {ai.rationale ? ` — “${ai.rationale}”` : ""}
          {ai.updated_by || ai.updated_at ? "." : ""}
        </p>
        <p className="text-[12px]">
          <Link href="/admin/control" className="text-foreground underline-offset-2 hover:underline">
            Change the AI switch in the control panel →
          </Link>
        </p>
      </section>
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
      <section className="grid gap-2" aria-labelledby="live-prices">
        <h2 id="live-prices" className="text-[15px] font-medium text-foreground">
          Live price table
        </h2>
        <p className="text-[12px] text-muted-foreground">
          USD per 1M tokens used for run estimates. OAuth providers do not return billing; Audit shows
          the rollup of these estimates.
        </p>
        <div className="overflow-x-auto border border-border">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-card/60 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">Provider</th>
                <th className="px-2 py-1.5 font-medium">Model</th>
                <th className="px-2 py-1.5 font-medium">Input / 1M</th>
                <th className="px-2 py-1.5 font-medium">Output / 1M</th>
                <th className="px-2 py-1.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {listModelPrices().map((row) => (
                <tr key={`${row.provider_id}:${row.model}`} className="border-t border-border">
                  <td className="px-2 py-1.5">{row.provider_id}</td>
                  <td className="px-2 py-1.5 font-mono text-[11px]">{row.model}</td>
                  <td className="px-2 py-1.5">${row.input_per_million.toFixed(2)}</td>
                  <td className="px-2 py-1.5">${row.output_per_million.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{row.updated_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
