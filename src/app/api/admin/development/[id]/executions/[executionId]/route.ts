/** Owner-only private manifest, section output and raw call-receipt inspection. */
import { historyMetadata, historyConfig } from '@/modules/development/execution';
import { getOwnerExecution, ownerSafe } from '@/modules/development/execution-store';
import { guarded, json } from '../../../_shared';
/** Reopen one execution within its exact experiment. */
export async function GET(request: Request, context: { params: Promise<{ id: string; executionId: string }> }) {
  return guarded(async () => {
    const { id, executionId } = await context.params;
    const execution = await getOwnerExecution(id, executionId);
    return json({ execution, history: ownerSafe(await historyMetadata(id, [execution], historyConfig(request))) });
  });
}
