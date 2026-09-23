/** True when the accuracy route can call a live completion (OAuth or API key). */
export function ideateRouteAllowsLlm(route: {
  connected: boolean;
  auth: "oauth" | "api_key" | "none";
}): boolean {
  return route.connected && (route.auth === "oauth" || route.auth === "api_key");
}
