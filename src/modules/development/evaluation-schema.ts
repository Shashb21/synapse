/** Independent per-section evaluator settings and exact immutable generation bindings. */
import { z } from 'zod';
import { costControlsSchema } from './cost-schema';
import { sectionSchema } from './schema';
import { executionRouteSchema } from './execution-schema';
/** Maximum items on either side of a semantic comparison, aggregated across selected references. */
export const MAX_EVALUATION_SEMANTIC_ITEMS = 2000;
export const evaluationMethodSchema = z.enum(['checks_only', 'rubric', 'reference', 'rubric_and_reference']);
export const sectionEvaluatorSchema = z.object({ method: evaluationMethodSchema.default('rubric'), route: executionRouteSchema.default(() => executionRouteSchema.parse({})) }).strict();
const sections = z.object(Object.fromEntries(sectionSchema.options.map(section => [section, sectionEvaluatorSchema.default(() => sectionEvaluatorSchema.parse({}))])) as Record<typeof sectionSchema.options[number], z.ZodDefault<typeof sectionEvaluatorSchema>>).strict();
export const evaluationConfigSchema = z.object({ sections: sections.default(() => sections.parse({})) }).strict();
export type EvaluationConfig = z.infer<typeof evaluationConfigSchema>;
export const startEvaluationSchema = z.object({
  cost_controls: costControlsSchema.optional(),
  execution_id: z.string().trim().min(1).max(200), attempt_id: z.string().trim().min(1).max(200), output_id: z.string().regex(/^[a-f0-9]{64}$/), section: sectionSchema,
  profile_id: z.string().trim().min(1).max(200).default('balanced'), profile_version: z.number().int().positive().default(1),
  reference_ids: z.array(z.string().trim().min(1).max(200)).max(20).default([]).refine(ids => new Set(ids).size === ids.length, 'Reference IDs must be unique.'),
  config: evaluationConfigSchema.default(() => evaluationConfigSchema.parse({})),
}).strict();
export type StartEvaluationInput = z.infer<typeof startEvaluationSchema>;
export const evaluatorReplySchema = z.object({
  criteria: z.array(z.object({ criterion_id: z.string().min(1).max(80), score: z.number().finite().min(0).max(4), reason: z.string().trim().min(1).max(4000) }).strict()).max(30),
  matches: z.array(z.object({ output_id: z.string().min(1).max(200), reference_id: z.string().min(1).max(400), reason: z.string().trim().min(1).max(4000) }).strict()).max(MAX_EVALUATION_SEMANTIC_ITEMS),
  unmatched_output_ids: z.array(z.string().min(1).max(200)).max(MAX_EVALUATION_SEMANTIC_ITEMS), unmatched_reference_ids: z.array(z.string().min(1).max(400)).max(MAX_EVALUATION_SEMANTIC_ITEMS),
}).strict();
export type EvaluatorReply = z.infer<typeof evaluatorReplySchema>;
