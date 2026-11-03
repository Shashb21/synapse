/** Owner-only execution spending evidence and audited allowance/correction actions. */
import { costActionSchema } from '@/modules/development/cost-schema';
import { applyCostAction, getCostAccount } from '@/modules/development/cost-store';
import { ownerSafe } from '@/modules/development/execution-store';
import { body, guarded, json } from '../../../../_shared';
type Context = { params: Promise<{ id: string; executionId: string }> };
/** Read cost evidence, keeping old executions without ledgers readable as null. */
export async function GET(_request: Request, context: Context) {
  return guarded(async () => { const { id, executionId } = await context.params; return json(ownerSafe({ account: await getCostAccount(id, executionId) })); });
}
/** Use only the authenticated guard's actor; strict action input rejects client actor fields. */
export async function POST(request: Request, context: Context) {
  return guarded(async actor => { const { id, executionId } = await context.params; return json(ownerSafe({ account: await applyCostAction(id, executionId, await body(request, costActionSchema), actor) })); });
}
