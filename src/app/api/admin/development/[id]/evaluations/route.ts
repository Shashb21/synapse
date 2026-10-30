/** Owner-only independent evaluations of exact persisted section outputs. */
import { getExperiment } from '@/modules/development/store';
import { listEvaluations } from '@/modules/development/evaluation-store';
import { startEvaluation } from '@/modules/development/evaluation';
import { startEvaluationSchema } from '@/modules/development/evaluation-schema';
import { deliveryConfiguration } from '@/modules/development/execution';
import { ownerSafe } from '@/modules/development/execution-store';
import { body, guarded, json, type DraftContext } from '../../_shared';
/** Read recent immutable evaluator attempts and durable-delivery availability. */
export async function GET(_request: Request, context: DraftContext) {
  return guarded(async () => { const { id } = await context.params; await getExperiment(id); return json(ownerSafe({ evaluations: await listEvaluations(id), delivery: deliveryConfiguration() })); });
}
/** Create a new evaluator attempt; never invoke generation or mutate existing scores. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async () => json(ownerSafe({ evaluation: await startEvaluation((await context.params).id, await body(request, startEvaluationSchema)) }), 202));
}
