/** Cancellation boundaries for stages that publish customer records. */
import { inWorkspaceTransaction, withWorkspaceTransaction } from "@/lib/iegp/db";
import type { ModuleContext } from "./contracts";
import { currentModelRun } from "./model-run";

/**
 * Check cancellation while rollback is possible. Call markWritten after a
 * customer write succeeds to acknowledge it once the transaction commits.
 */
export async function commitStageMutation<T>(
  ctx: ModuleContext | undefined,
  write: (markWritten: () => void) => Promise<T>,
  transaction = withWorkspaceTransaction<T>,
): Promise<T> {
  let wroteCustomerRows = false;
  const result = await transaction(async () => {
    currentModelRun()?.check();
    const value = await write(() => { wroteCustomerRows = true; });
    currentModelRun()?.check();
    return value;
  });
  // A savepoint leaves the enclosing owner free to roll everything back.
  if (wroteCustomerRows && !inWorkspaceTransaction()) ctx?.onMutationCommitted?.();
  return result;
}

/** Keep direct module callers working while the kernel collects writes for atomic publication. */
export async function stageWrite(ctx: ModuleContext, write: () => Promise<void>): Promise<void> {
  if (ctx.replay?.evaluation) return;
  if (ctx.deferWrite) ctx.deferWrite(write);
  else await withWorkspaceTransaction(write);
}
