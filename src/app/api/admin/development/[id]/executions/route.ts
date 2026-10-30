/** Owner-only immutable execution creation and private history. */
import { startExecution, startExecutionSchema, deliveryConfiguration, historyMetadata, historyConfig } from '@/modules/development/execution';
import { listOwnerExecutionPage, getOwnerExecution, ownerSafe } from '@/modules/development/execution-store';
import { getExperiment } from '@/modules/development/store';
import { body, guarded, json, type DraftContext } from '../../_shared';
/** Return recent history plus the durable-delivery availability gate. */
export async function GET(request: Request, context: DraftContext) {
  return guarded(async () => {
    const { id } = await context.params;
    await getExperiment(id);
    const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
    const page = await listOwnerExecutionPage(id, cursor);
    return json({ ...page, delivery: deliveryConfiguration(), history: ownerSafe(await historyMetadata(id, page.executions, historyConfig(request))) });
  });
}
/** Accept a frozen execution after all availability, revision and prerequisite checks. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async actor => {
    const id = (await context.params).id;
    const execution = await startExecution(id, await body(request, startExecutionSchema), actor);
    return json({ execution: await getOwnerExecution(id, execution.id) }, 202);
  });
}
