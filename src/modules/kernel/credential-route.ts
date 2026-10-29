/** Client-safe route selection based only on provider policy and credential presence. */
import { STAGES, type StageId } from "./contracts";

export type CredentialProvider = {
  id: string;
  label: string;
  auth: "api_key" | "none";
  default_model: string;
  status: "configured" | "missing";
  models?: string[];
};
export type CredentialRoute = { provider_id: string; model: string; fallbacks: string[] };

/** Only model stages require provider credentials. Shared with runtime routing. */
export function stageHasRoute(stage: StageId): boolean {
  return STAGES[stage].kind === "agentic";
}

/** Select the first configured cloud provider in the saved, permitted order; never call it. */
export function selectCredentialRoute(config: CredentialRoute, providers: CredentialProvider[]) {
  const rejected: { id: string; reason: "unknown" | "not_llm" | "missing" }[] = [];
  const candidates = [config.provider_id, ...config.fallbacks].filter(id => id !== "deterministic-local");
  for (const [index, id] of candidates.entries()) {
    const provider = providers.find(candidate => candidate.id === id);
    if (!provider) rejected.push({ id, reason: "unknown" });
    else if (provider.auth === "none") rejected.push({ id, reason: "not_llm" });
    else if (provider.status !== "configured") rejected.push({ id, reason: "missing" });
    else return { selected: { provider, model: index === 0 ? config.model : provider.default_model, fallback: index > 0 }, rejected };
  }
  return { selected: null, rejected };
}
