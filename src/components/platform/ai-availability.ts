/** Read-only customer permission and credential feedback; no secrets, I/O or live provider checks. */
import { AI_SECTIONS, type AiSections } from "@/modules/kernel/ai-sections";
import { STAGE_IDS } from "@/modules/kernel/contracts";
import { selectCredentialRoute, stageHasRoute, type CredentialProvider, type CredentialRoute } from "@/modules/kernel/credential-route";
export type SummaryRoute = CredentialRoute & { stage: string };
export type AiSummaryInput = {
  master: boolean | null;
  sections: AiSections | null;
  /** Raw saved values describe stored preferences. */
  routes: SummaryRoute[] | null;
  /** Server-normalized values describe execution credential consequences. */
  runtimeRoutes: SummaryRoute[] | null;
  providers: CredentialProvider[] | null;
};
const UNVERIFIED = "Key presence only; provider access, quota and connectivity are unverified.";

/** Describe the credential consequence of a draft or saved route without claiming a successful call. */
export function credentialFeedback(route: CredentialRoute, providers: CredentialProvider[] | null): string {
  if (!providers) return "Credential status unavailable. You can save preferences for later.";
  const { selected } = selectCredentialRoute(route, providers);
  if (!selected) return `No configured provider for this route. You can save preferences for later. ${UNVERIFIED}`;
  return selected.fallback
    ? `Primary key missing; configured fallback ${selected.provider.label} would be used. ${UNVERIFIED}`
    : `Primary key configured. ${UNVERIFIED}`;
}

/** Derive summary copy from independently known settings; unknown reads stay unknown. */
export function buildAiSummary(input: AiSummaryInput) {
  const { master, sections, routes, runtimeRoutes, providers } = input;
  const enabled = sections ? AI_SECTIONS.filter(section => sections[section.id]) : null;
  const permitted = enabled?.filter(section => section.built);
  const modelStages = STAGE_IDS.filter(stageHasRoute);
  const modelRoutes = routes?.filter(route => modelStages.some(stage => stage === route.stage));
  const completeRoutes = modelRoutes && modelStages.every(stage => modelRoutes.some(route => route.stage === stage));
  const activeStages = permitted?.flatMap(section => [...section.stages]).filter(stage => modelStages.some(id => id === stage));
  const activeRoutes = activeStages?.map(stage => runtimeRoutes?.find(route => route.stage === stage));
  const selected = activeRoutes?.map(route => route && providers ? selectCredentialRoute(route, providers).selected : null);
  const blocked = selected?.filter(route => !route).length ?? 0;
  const fallback = selected?.filter(route => route?.fallback).length ?? 0;
  const plural = (count: number, singular: string, multiple = `${singular}s`) => count === 1 ? singular : multiple;
  let customer = "Customer permission unavailable.";
  if (master === false) customer = "Off for every customer. Section preferences are stored for later.";
  else if (master === true && permitted) customer = permitted.length
    ? `${permitted.length} ${plural(permitted.length, "section")} permitted for customers; model use also needs configured credentials.`
    : "No customer AI sections enabled.";
  let routing = "Routing configuration unavailable.";
  if (completeRoutes && modelRoutes) {
    const providerIds = new Set(modelRoutes.map(route => route.provider_id));
    const models = new Set(modelRoutes.map(route => route.model));
    const first = modelRoutes[0];
    const provider = providers?.find(candidate => candidate.id === first?.provider_id);
    routing = providerIds.size > 1 || models.size > 1
      ? `Mixed ${providerIds.size > 1 ? models.size > 1 ? "providers and models" : "providers" : "models"} across ${modelStages.length} model stages.`
      : provider
        ? `${provider.label}${provider.models?.includes(first.model) ? ` · ${first.model}` : " (saved model)"} across ${modelStages.length} model stages.`
        : `One saved provider across ${modelStages.length} model stages. See Routing.`;
  }
  let credentials = "Credential readiness unavailable.";
  if (activeStages?.length === 0) credentials = "Enabled sections do not call a model; no model key required.";
  else if (activeStages && providers && activeRoutes?.every(Boolean)) {
    credentials = blocked
      ? `${blocked} enabled model ${plural(blocked, "stage has", "stages have")} no configured provider. ${UNVERIFIED}`
      : fallback
        ? `${fallback} enabled model ${plural(fallback, "stage uses", "stages use")} a configured fallback. ${UNVERIFIED}`
        : `All enabled model stages have configured primary keys. ${UNVERIFIED}`;
  }
  if (master === false && activeStages?.length) credentials = `Stored enabled sections: ${credentials}`;
  let action = { href: "#ai-switch", label: master === false ? "Review master switch" : "Review AI sections" };
  if (master === null || sections === null) action = { href: "#ai-switch", label: "Review unavailable AI settings" };
  else if (master === false || !permitted?.length) { /* Review the switch before inactive model settings. */ }
  else if (!completeRoutes) action = { href: "#routing", label: "Review unavailable routing" };
  else if (activeStages?.length && (!providers || blocked || fallback)) action = { href: "#providers", label: providers ? "Review provider credentials" : "Review unavailable credential status" };
  return {
    master: master === null ? "Status unavailable" : master ? "On" : "Off",
    sections: enabled ? `${enabled.length} of ${AI_SECTIONS.length} enabled; ${AI_SECTIONS.length - enabled.length} disabled (stored preferences).` : "Section settings unavailable.",
    customer, routing, credentials, action,
  };
}
