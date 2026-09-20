import { anthropicModel } from "@/lib/config";
import { getExtractRun, listExtractRuns } from "@/lib/iegp/extract/store";
import { agenticAuthStatus } from "./gateway";
import { reauthHistory } from "./reauth";
import {
  agenticCallSummary,
  loadStoredCalls,
  loadStoredReauth,
} from "./tracking";

export async function assembleObservability(limit = 400) {
  const auth = agenticAuthStatus();
  const calls = await loadStoredCalls(limit);
  const storedReauth = await loadStoredReauth(200);
  const hookReauth = reauthHistory();
  const reauthById = new Map<string, (typeof storedReauth)[number]>();
  for (const event of [...storedReauth, ...hookReauth]) {
    const key = event.id ?? `${event.at}:${event.type}:${event.request_id ?? ""}`;
    reauthById.set(key, event);
  }
  const reauth = [...reauthById.values()].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const runs = await listExtractRuns(25).catch(() => []);
  const extract = await Promise.all(
    runs.map(async (run) => {
      const detail = await getExtractRun(run.id).catch(() => null);
      return {
        id: run.id,
        kind: run.kind,
        status: run.status,
        title: run.title,
        created_at: run.created_at,
        completed_at: run.completed_at,
        persist: run.persist,
        prompt_version: run.prompt_version,
        error: run.error,
        actor_name: run.actor_name,
        actor_function: run.actor_function,
        steps: (detail?.steps ?? []).map((step) => ({
          id: step.id,
          round: step.round,
          role: step.role,
          started_at: step.started_at,
          ended_at: step.ended_at,
          latency_ms: step.latency_ms,
          error: step.error,
          request: step.request,
          response: step.response,
        })),
      };
    }),
  );
  return {
    at: new Date().toISOString(),
    model: anthropicModel(),
    auth,
    summary: agenticCallSummary(calls),
    calls,
    reauth,
    extract,
  };
}
