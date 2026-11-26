import type { StageId } from "./contracts";
import { normalizeRouteConfig, resolveRoute, routeConfigs, type RouteConfig } from "./routing";
import { assertEvaluationRoute } from "./evaluation-isolation";
import { TrustedApplicationError } from "./stage-errors";

/** Resolve the exact saved primary provider, model, parameters and backup policy. */
export async function approvedEvaluationRoute(stage: StageId, lockedConfig?: RouteConfig) {
  const config = lockedConfig ?? (await routeConfigs({ preserveStored: true })).find((row) => row.stage === stage);
  if (!config) throw new TrustedApplicationError("Configure this stage before evaluating a revision.");
  const route = await resolveRoute(stage, normalizeRouteConfig(config));
  assertEvaluationRoute(route);
  if (
    route.stage !== stage ||
    route.provider_id !== config.provider_id ||
    route.model !== config.model ||
    route.params.temperature !== config.params.temperature ||
    route.params.max_tokens !== config.params.max_tokens ||
    JSON.stringify(route.fallbacks) !== JSON.stringify(config.fallbacks)
  ) {
    throw new TrustedApplicationError(
      "The saved primary model or settings cannot be served. Confirm the stage routing before evaluating.",
    );
  }
  return route;
}
