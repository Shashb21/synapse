/** Derive actionable generation blockers without replacing server validation. */
import { executionConfigSchema, executionRouteSchema, EXECUTION_ROLES, SECTION_DEPENDENCIES } from '@/modules/development/execution-schema';
import type { ExecutionConfig, ExecutionRoute } from '@/modules/development/execution-schema';
import type { DevelopmentSection } from '@/modules/development/schema';
import type { SectionAttempt } from '@/modules/development/execution-store';
import type { AttemptHistoryMetadata } from '@/modules/development/execution';
import type { ProviderKeyView } from '@/modules/llm/api-keys';

type Input = {
  disabled: boolean; disabledReason?: string; pending: boolean; loading: boolean;
  historyState: 'loading' | 'ready' | 'unavailable'; deliveryAvailable: boolean;
  active: boolean; hasSources: boolean; config: ExecutionConfig | null;
  providers: Pick<ProviderKeyView, 'provider_id' | 'status'>[]; allowance: number;
};

/** Return blockers in the order a user can resolve them. */
export function generationReadiness(input: Input, target: DevelopmentSection | 'all'): string[] {
  const blockers: string[] = [];
  if (input.disabled) blockers.push(input.disabledReason ?? 'Save or refresh the experiment before running.');
  if (input.loading || input.pending || input.historyState === 'loading') blockers.push('Wait for the current operation to finish.');
  if (input.historyState === 'unavailable') blockers.push('Reload execution history before running.');
  if (!input.hasSources) blockers.push('Add a source snapshot in Documents.');
  if (!input.deliveryAvailable) blockers.push('Execution delivery is unavailable; check server configuration.');
  if (input.active) blockers.push('Wait for the active execution to finish.');
  const parsed = executionConfigSchema.safeParse(input.config);
  if (!parsed.success) blockers.push('Review invalid model settings.');
  else {
    const config = parsed.data;
    const sections = target === 'all' ? Object.keys(config.stages) as DevelopmentSection[] : [target];
    const roles = config.mode === 'single_pass' ? ['proposer'] as const : EXECUTION_ROLES;
    const unavailable = sections.some(section => roles.some(role => {
      const route = config.stages[section].overrides[role] ?? config.stages[section].route;
      return ![route.provider_id, ...route.fallbacks].some(id => input.providers.some(provider => provider.provider_id === id && provider.status === 'configured'));
    }));
    if (unavailable) blockers.push('Configure credentials for the selected provider or an allowed fallback.');
  }
  if (!Number.isFinite(input.allowance) || input.allowance < 0) blockers.push('Enter a finite nonnegative generation allowance.');
  return blockers;
}

/** Bind latest successful, current transitive prerequisites and verify their lineage. */
export function currentPrerequisites(target: DevelopmentSection | 'all', attempts: SectionAttempt[], metadata: Record<string, AttemptHistoryMetadata>): Partial<Record<DevelopmentSection, { attempt_id: string; output_id: string }>> | null {
  const required = new Set<DevelopmentSection>();
  function visit(section: DevelopmentSection) {
    for (const dependency of SECTION_DEPENDENCIES[section]) {
      if (!required.has(dependency)) { required.add(dependency); visit(dependency); }
    }
  }
  if (target !== 'all') visit(target);
  const result: Partial<Record<DevelopmentSection, { attempt_id: string; output_id: string }>> = {};
  for (const section of required) {
    const attempt = attempts.find(item => item.section === section);
    if (!attempt || attempt.status !== 'succeeded' || !attempt.result || metadata[attempt.id]?.freshness.current !== true) return null;
    result[section] = { attempt_id: attempt.id, output_id: attempt.result.output_id };
  }
  for (const section of required) {
    const attempt = attempts.find(item => item.section === section)!;
    for (const dependency of SECTION_DEPENDENCIES[section]) {
      if (attempt.prerequisites?.[dependency] !== result[dependency]?.attempt_id || attempt.result?.prerequisite_ids?.[dependency] !== result[dependency]?.output_id) return null;
    }
  }
  return result;
}

/** Resolve the first configured route as the server does at dispatch. */
export function effectiveRoute(route: ExecutionRoute, providers: Pick<ProviderKeyView, 'provider_id' | 'status' | 'default_model'>[]): { provider_id: string; model: string; fallback: boolean } | null {
  for (const id of [route.provider_id, ...route.fallbacks]) {
    const provider = providers.find(item => item.provider_id === id && item.status === 'configured');
    if (provider) return { provider_id: id, model: id === route.provider_id ? route.model : provider.default_model, fallback: id !== route.provider_id };
  }
  return null;
}

/** Check only routes used by the selected evaluation method. */
export function evaluationRouteReadiness(method: string, route: ExecutionRoute, providers: Pick<ProviderKeyView, 'provider_id' | 'status' | 'default_model'>[]): string[] {
  // Reference-only evaluation may use no model when usable reference or output items are absent.
  // Those server-derived items are not available here, so let the server decide.
  if (method === 'checks_only' || method === 'reference') return [];
  if (!executionRouteSchema.safeParse(route).success) return ['Review invalid evaluator model settings.'];
  if (!effectiveRoute(route, providers)) return ['Configure credentials for the selected evaluator provider or an allowed fallback.'];
  return [];
}
