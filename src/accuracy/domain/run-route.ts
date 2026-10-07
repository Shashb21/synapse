/**
 * How a lab run's route reads on the Runs page. Mechanical modules (status
 * derive, validation gate, upload, …) never call a model, even though the
 * kernel may have resolved a default route for them, so they read "No model".
 */

export const NO_MODEL_ROUTE = "No model";

export function runRouteLabel(route: unknown, usesModel: boolean): string {
  if (!usesModel || !route || typeof route !== "object") return NO_MODEL_ROUTE;
  const { provider_id, provider_label, model, degraded } = route as {
    provider_id?: unknown;
    provider_label?: unknown;
    model?: unknown;
    degraded?: unknown;
  };
  if (typeof provider_label !== "string" || !provider_label || provider_id === "none") {
    return NO_MODEL_ROUTE;
  }
  const modelPart = typeof model === "string" && model ? ` · ${model}` : "";
  return `${provider_label}${modelPart}${degraded === true ? " (degraded)" : ""}`;
}
