/** Keeps diagnostics isolated from live workspace writes and learning. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedRoute } from "./contracts";
import { isDemoReplayProvider } from "@/lib/demo/replay-provider";
import { TrustedApplicationError } from "./stage-errors";

// Next.js can load separate copies of this module while sharing the cached
// database router. Every copy must read isolation from the same async scope.
const globalScope = globalThis as typeof globalThis & { __synapseEvaluationIsolation?: AsyncLocalStorage<boolean> };
const isolated = (globalScope.__synapseEvaluationIsolation ??= new AsyncLocalStorage<boolean>());

/** Run a diagnostic with isolation active for its asynchronous work. */
export function withEvaluationIsolation<T>(fn: () => Promise<T>): Promise<T> {
  return isolated.run(true, fn);
}

/** Whether the current asynchronous work belongs to a diagnostic. */
export function inEvaluationIsolation(): boolean {
  return isolated.getStore() === true;
}

export function assertEvaluationRoute(route: ResolvedRoute): void {
  if (
    !route.connected ||
    route.auth !== "api_key" ||
    route.degraded !== false ||
    !route.model?.trim() ||
    !route.provider_id?.trim() ||
    isDemoReplayProvider(route.provider_id) ||
    !Number.isFinite(route.params?.temperature) ||
    !Number.isInteger(route.params?.max_tokens) ||
    route.params.temperature < 0 ||
    route.params.temperature > 2 ||
    route.params.max_tokens < 1 ||
    !Array.isArray(route.fallbacks)
  ) {
    throw new TrustedApplicationError("Select a connected primary model and valid settings before evaluating.");
  }
}
