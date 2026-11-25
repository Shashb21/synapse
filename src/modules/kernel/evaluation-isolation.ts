import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedRoute } from "./contracts";
import { isDemoReplayProvider } from "@/lib/demo/replay-provider";
import { TrustedApplicationError } from "./stage-errors";

const isolated = new AsyncLocalStorage<boolean>();

export function withEvaluationIsolation<T>(fn: () => Promise<T>): Promise<T> {
  return isolated.run(true, fn);
}

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
