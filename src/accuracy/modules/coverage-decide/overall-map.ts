import type { CoverageDecision } from "./schema";

/** Canonical assessment labels are also the UI labels; Limited stays distinct. */
export type CoverageUiOverall = CoverageDecision["overall"];
export function mapCoverageOverallToUi(overall: CoverageDecision["overall"]): CoverageUiOverall { return overall; }

/** True when the accuracy route can call a live completion (its API key is set). */
export function coverageRouteAllowsLlm(route: {
  connected: boolean;
  auth: "api_key" | "none";
}): boolean {
  return route.connected && route.auth === "api_key";
}
