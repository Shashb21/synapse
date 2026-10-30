/** Owner-only private manifest, section output and raw call-receipt inspection. */
import { getExecution } from '@/modules/development/execution-store';
import { guarded, json } from '../../../_shared';
/** Reopen one execution within its exact experiment. */
export async function GET(_request: Request, context: { params: Promise<{ id: string; executionId: string }> }) {
  return guarded(async () => {
    const { id, executionId } = await context.params;
    return json({ execution: await getExecution(id, executionId) });
  });
}
