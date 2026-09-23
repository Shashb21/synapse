import type { CoverageDecision } from "./schema";

/** Manual coverage UI / store overall labels. */
export type CoverageUiOverall = "covers" | "partial" | "none" | "unknown";

/**
 * Map schema-locked LLM overall (`full` | `partial` | `limited` | `not_relevant`)
 * onto the Coverage UI decide buttons.
 */
export function mapCoverageOverallToUi(
  overall: CoverageDecision["overall"],
): CoverageUiOverall {
  switch (overall) {
    case "full":
      return "covers";
    case "partial":
    case "limited":
      return "partial";
    case "not_relevant":
      return "none";
    default:
      return "unknown";
  }
}

/** True when the accuracy route can call a live completion (OAuth or API key). */
export function coverageRouteAllowsLlm(route: {
  connected: boolean;
  auth: "oauth" | "api_key" | "none";
}): boolean {
  return route.connected && (route.auth === "oauth" || route.auth === "api_key");
}
