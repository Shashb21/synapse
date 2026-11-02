/** Owner-only provider-free spending preview for generation or an evaluator-only run. */
import { z } from 'zod';
import { estimateDevelopmentCost } from '@/modules/development/cost';
import { getExperiment } from '@/modules/development/store';
import { sectionSchema } from '@/modules/development/schema';
import { body, guarded, json, type DraftContext } from '../../_shared';
const schema = z.object({ target: z.union([z.literal('all'), sectionSchema]).optional(), mode: z.enum(['single_pass', 'standard']).optional(), evaluation_only: z.boolean().optional() }).strict();
/** Preview every category with dynamic uncertainty; never send a provider request. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async () => { await getExperiment((await context.params).id); return json({ estimate: estimateDevelopmentCost(await body(request, schema)) }); });
}
