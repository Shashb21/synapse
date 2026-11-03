/** Frozen experiment role routes, resolved without reading or mutating shared routing. */
import { findProvider, providerServes, NoRouteError } from '@/modules/llm/provider';
import { providerConfigured } from '@/modules/llm/api-keys';
import type { CompletionRole, ResolvedRoute } from '@/modules/kernel/contracts';
import { EXECUTION_ROLES, SECTION_STAGES, type ExecutionConfig, type ExecutionRoute } from './execution-schema';
import type { DevelopmentSection } from './schema';
export type FrozenRoute = { requested: ExecutionRoute; actual: ResolvedRoute; actual_temperature: number | null };
export type FrozenRoutes = Record<DevelopmentSection, Partial<Record<CompletionRole, FrozenRoute>>>;
/** Resolve only explicitly permitted credential fallbacks and retain both route identities. */
export function freezeRoute(section: DevelopmentSection, requested: ExecutionRoute): FrozenRoute {
  for (const id of [requested.provider_id, ...requested.fallbacks]) {
    const provider = findProvider(id);
    if (!provider || provider.auth !== 'api_key' || !providerConfigured(provider)) continue;
    const model = id === requested.provider_id ? requested.model : provider.default_model;
    if (!providerServes(provider, model)) throw new NoRouteError('The selected provider does not serve that model.');
    const actual: ResolvedRoute = { stage: SECTION_STAGES[section], provider_id: id, provider_label: provider.label, model, auth: 'api_key', connected: true, params: { temperature: requested.temperature, max_tokens: requested.max_tokens }, fallbacks: requested.fallbacks, degraded: id !== requested.provider_id, reason: id !== requested.provider_id ? 'Explicit fallback: requested provider credentials unavailable.' : null };
    return { requested: structuredClone(requested), actual, actual_temperature: provider.sendsTemperature?.(model) === false ? null : requested.temperature };
  }
  throw new NoRouteError('Configure credentials for the requested provider or an explicitly permitted fallback.');
}
/** Freeze active generation roles; the evaluator is configuration only and never dispatched. */
export function freezeRoutes(config: ExecutionConfig, sections: DevelopmentSection[]): FrozenRoutes {
  const routes = {} as FrozenRoutes;
  for (const section of sections) {
    routes[section] = {};
    for (const role of EXECUTION_ROLES) {
      if (config.mode === 'single_pass' && role !== 'proposer') continue;
      routes[section][role] = freezeRoute(section, config.stages[section].overrides[role] ?? config.stages[section].route);
    }
  }
  return routes;
}
