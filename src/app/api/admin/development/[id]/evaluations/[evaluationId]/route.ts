/** Private polling for an exact immutable evaluator attempt. */
import { getEvaluation } from '@/modules/development/evaluation-store';
import { ownerSafe } from '@/modules/development/execution-store';
import { guarded, json } from '../../../_shared';
/** Return a job only within its selected experiment. */
export async function GET(_request: Request, context: { params: Promise<{ id: string; evaluationId: string }> }) {
  return guarded(async () => { const { id, evaluationId } = await context.params; return json(ownerSafe({ evaluation: await getEvaluation(id, evaluationId) })); });
}
