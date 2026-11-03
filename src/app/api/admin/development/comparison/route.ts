/** Owner-only bounded read of saved trials and their exact evaluation histories. */
import { z } from 'zod';
import { getExperiment } from '@/modules/development/store';
import { getExecution, ownerSafe } from '@/modules/development/execution-store';
import { listAttemptEvaluations } from '@/modules/development/evaluation-store';
import { buildComparison } from '@/modules/development/comparison';
import { DevelopmentError } from '@/modules/development/schema';
import { guarded, json } from '../_shared';
const id = z.string().trim().min(1).max(200);
const querySchema = z.object({ left_experiment_id: id, left_execution_id: id, right_experiment_id: id, right_execution_id: id }).strict();
/** Read immutable history only after owner authorization and query validation. */
export async function GET(request: Request) {
  return guarded(async () => {
    if (request.url.length > 2048) throw new DevelopmentError(400, 'invalid_input', 'Choose two saved experiment executions with bounded identifiers.');
    const params = new URL(request.url).searchParams;
    if (new Set(params.keys()).size !== [...params.keys()].length) throw new DevelopmentError(400, 'invalid_input', 'Comparison query fields must occur exactly once.');
    const query = querySchema.parse(Object.fromEntries(params));
    const read = async (experimentId: string, executionId: string) => {
      await getExperiment(experimentId);
      // Compare raw identities first; redact the complete response after comparison.
      const execution = await getExecution(experimentId, executionId);
      const evaluations = await listAttemptEvaluations(experimentId, execution.sections.map(attempt => attempt.id));
      return { execution, evaluations };
    };
    const [left, right] = await Promise.all([read(query.left_experiment_id, query.left_execution_id), read(query.right_experiment_id, query.right_execution_id)]);
    return json({ comparison: ownerSafe(buildComparison(left, right)) });
  });
}
