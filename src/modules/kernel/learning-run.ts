/** Commit a learning result and its workspace generation trace together. */
import { withWorkspaceTransaction } from "@/lib/iegp/db";
import type { ResolvedRoute } from "./contracts";
import { closeRun, withRunningRun, type RunRecorder } from "./observability";

/** A savepoint rolls back partial learning writes while preserving the row lock for the diagnostic. */
export async function recordLearningRun<T>(
  recorder: RunRecorder,
  route: ResolvedRoute | null,
  generate: (assertLive: () => Promise<void>) => Promise<{ value: T; output: unknown }>,
  markFailed?: () => Promise<void>,
): Promise<T> {
  const fail = async (error: unknown) => {
    await markFailed?.();
    await closeRun({ recorder, route, status: "error", output: {}, error: error instanceof Error ? error.message : String(error) });
  };
  let failure: { error: unknown } | undefined;
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = await withRunningRun(recorder, async assertLive => {
      try {
        return await withWorkspaceTransaction(async () => {
          const result = await generate(assertLive);
          await closeRun({ recorder, route, status: "ok", output: result.output });
          return { value: result.value };
        });
      } catch (error) {
        failure = { error };
        await fail(error);
        return failure;
      }
    });
  } catch (transactionError) {
    const error = failure ? failure.error : transactionError;
    // On a dropped connection the generation transaction rolled back. Only
    // claim a still-running row: COMMIT may have succeeded before disconnect.
    try {
      await withRunningRun(recorder, () => fail(error));
    } catch {
      console.error("Could not finalize interrupted learning run", { run_id: recorder.id });
    }
    throw error;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
