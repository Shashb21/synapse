/** Browser ingestion runner: one bounded request per saved pipeline step. */
import { NETWORK_ERROR, postJson, type PostResult } from "@/lib/post-json";

const STAGE_LABELS: Record<string, string> = {
  S0: "Saving file…",
  S1: "Reading document…",
  S2: "Extracting evidence gaps…",
  S3: "Extracting tactics…",
  S4: "Mapping tactics to gaps…",
};

// Stop waiting after three minutes per stage. Server work may still be finishing;
// retrying uses its saved checkpoint and cannot run a second copy concurrently.
const STEP_TIMEOUT_MS = 180_000;

type ProgressReply = { job_id: string; done: boolean; stage: string | null; completed: number; total: number; code?: string; error?: string };

/** Advance ingestion to completion, reporting progress and preserving server errors. */
export async function postIngest(
  payload: Record<string, unknown>,
  onProgress: (label: string) => void,
  signal?: AbortSignal,
): Promise<PostResult<ProgressReply>> {
  try {
    let job_id: string | undefined;
    let completed = 0;
    let total: number | undefined;
    onProgress(STAGE_LABELS.S0);
    let deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!signal?.aborted) {
      const timeout = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const res = await postJson<ProgressReply>("/api/iegp", {
        ...(job_id ? { action: payload.action, ingest_job_id: job_id } : payload),
        incremental: "true",
      }, { signal: requestSignal });
      if (requestSignal.aborted) return {
        ok: false, status: 0,
        json: { error: signal?.aborted ? "Ingestion paused. Select the file again to continue." : "This step is taking longer than expected. Retry to continue from the last completed step; the server may still be finishing it." },
      };
      if (!res.ok) {
        if (res.json?.code === "ingest_busy" && Date.now() < deadline) {
          onProgress("An ingestion step is already running. Waiting to continue…");
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        return {
          ...res,
          json: { ...(res.json && typeof res.json === "object" ? res.json : {}),
            error: typeof res.json?.error === "string" && res.json.error ? res.json.error : "Ingestion could not finish. Retry to continue from the last completed step." },
        };
      }
      const next = res.json;
      if (!next || typeof next !== "object" || typeof next.job_id !== "string" || !/^[a-f0-9]{64}$/.test(next.job_id) ||
          typeof next.done !== "boolean" || typeof next.completed !== "number" || typeof next.total !== "number" || !Number.isInteger(next.completed) || !Number.isInteger(next.total) ||
          next.total < 2 || next.total > 5 || next.completed < completed || next.completed > next.total ||
          (job_id && next.job_id !== job_id) || (total !== undefined && next.total !== total) ||
          (next.done ? next.completed !== next.total || next.stage !== null : next.completed >= next.total || !next.stage || !STAGE_LABELS[next.stage] || next.completed <= completed)) {
        return { ok: false, status: res.status, json: { error: "Could not confirm ingestion progress. Retry to continue from the last completed step." } };
      }
      if (next.done) return res;
      job_id = next.job_id;
      completed = next.completed;
      total = next.total;
      deadline = Date.now() + STEP_TIMEOUT_MS;
      onProgress(`${STAGE_LABELS[next.stage!]} (${completed + 1} of ${next.total})`);
    }
    return { ok: false, status: 0, json: { error: "Ingestion paused. Select the file again to continue." } };
  } catch {
    return { ok: false, status: 0, json: { error: NETWORK_ERROR } };
  }
}
