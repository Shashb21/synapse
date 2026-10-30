/** Bounded source-only experiment configuration; provider availability is checked at dispatch. */
import { z } from 'zod';
import { DEFAULT_ROUTE_PROVIDER, DEFAULT_ROUTE_FALLBACKS, findProvider, providerServes } from '@/modules/llm/provider';
import type { CompletionRole, StageId } from '@/modules/kernel/contracts';
import { sectionSchema, type DevelopmentSection } from './schema';
export const EXECUTION_ROLES = ['proposer', 'critic', 'reviser', 'internal_judge'] as const satisfies readonly CompletionRole[];
export const executionModeSchema = z.enum(['standard', 'single_pass']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export const SECTION_STAGES: Record<DevelopmentSection, StageId> = { gap_extraction: 'S2', tactic_extraction: 'S3', matching_coverage: 'S4', partial_splitting: 'S6' };
export const SECTION_DEPENDENCIES: Record<DevelopmentSection, DevelopmentSection[]> = { gap_extraction: [], tactic_extraction: [], matching_coverage: ['gap_extraction', 'tactic_extraction'], partial_splitting: ['matching_coverage'] };
const defaultRoute = () => ({ provider_id: DEFAULT_ROUTE_PROVIDER, model: findProvider(DEFAULT_ROUTE_PROVIDER)!.default_model, temperature: 0.2, max_tokens: 16000, fallbacks: [...DEFAULT_ROUTE_FALLBACKS] });
export const executionRouteSchema = z.object({
  provider_id: z.string().trim().min(1).max(100).default(DEFAULT_ROUTE_PROVIDER),
  model: z.string().trim().min(1).max(200).default(() => defaultRoute().model),
  temperature: z.number().finite().min(0).max(2).default(0.2),
  max_tokens: z.number().int().min(256).max(64000).default(16000),
  fallbacks: z.array(z.string().trim().min(1).max(100)).max(4).default(() => [...DEFAULT_ROUTE_FALLBACKS]),
}).strict().superRefine((value, ctx) => {
  const provider = findProvider(value.provider_id);
  if (!provider || provider.auth !== 'api_key' || !providerServes(provider, value.model)) ctx.addIssue({ code: 'custom', message: 'Choose an available provider and supported model.' });
  if (new Set(value.fallbacks).size !== value.fallbacks.length || value.fallbacks.includes(value.provider_id) || value.fallbacks.some(id => !findProvider(id) || findProvider(id)!.auth !== 'api_key')) ctx.addIssue({ code: 'custom', message: 'Fallbacks must be unique available providers, excluding the primary.' });
});
export type ExecutionRoute = z.infer<typeof executionRouteSchema>;
export const stageExecutionConfigSchema = z.object({
  route: executionRouteSchema.default(defaultRoute),
  overrides: z.object({ proposer: executionRouteSchema.optional(), critic: executionRouteSchema.optional(), reviser: executionRouteSchema.optional(), internal_judge: executionRouteSchema.optional() }).strict().default({}),
}).strict();
const stagesSchema = z.object(Object.fromEntries(sectionSchema.options.map(section => [section, stageExecutionConfigSchema.default(() => ({ route: defaultRoute(), overrides: {} }))])) as Record<DevelopmentSection, z.ZodDefault<typeof stageExecutionConfigSchema>>).strict();
export const executionConfigSchema = z.object({
  mode: executionModeSchema.default('standard'),
  stages: stagesSchema.default(() => stagesSchema.parse({})),
  evaluator: executionRouteSchema.default(defaultRoute),
}).strict().superRefine((config, ctx) => {
  if (config.mode === 'single_pass') for (const section of sectionSchema.options) for (const role of ['critic', 'reviser', 'internal_judge'] as const) {
    if (config.stages[section].overrides[role]) ctx.addIssue({ code: 'custom', path: ['stages', section, 'overrides', role], message: 'Single pass omits this role; remove its unused override.' });
  }
});
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
