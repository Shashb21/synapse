/** Owner-only immutable execution creation and private history. */
import { startExecution, startExecutionSchema, deliveryConfiguration } from '@/modules/development/execution';
import { listExecutions } from '@/modules/development/execution-store';
import { getExperiment } from '@/modules/development/store';
import { body, guarded, json, type DraftContext } from '../../_shared';
/** Return recent history plus the durable-delivery availability gate. */
export async function GET(_request: Request, context: DraftContext) {
  return guarded(async () => {
    const { id } = await context.params;
    await getExperiment(id);
    return json({ executions: await listExecutions(id), delivery: deliveryConfiguration() });
  });
}
/** Accept a frozen execution after all availability, revision and prerequisite checks. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async () => json({ execution: await startExecution((await context.params).id, await body(request, startExecutionSchema)) }, 202));
}
