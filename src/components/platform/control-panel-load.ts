/** Independent server reads for the owner control panel; errors never cross the client boundary. */
import { aiSwitch, storedAiSections } from "@/modules/kernel/ai-switch";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { normalizeRouteConfig, resolveRoute, routeConfigs } from "@/modules/kernel/routing";
import { sessionContext } from "@/modules/auth/session";
import { ownerAccess } from "@/modules/auth/owner";
import { NoRouteError } from "@/modules/llm/provider";

/** A failed read has no value: unknown configuration cannot masquerade as a default. */
export type LoadResult<T> = { status: "ready"; value: T } | { status: "unavailable" };
export type RoutePreview = {
  state: "resolved" | "fallback" | "no_provider" | "off";
  label: string | null;
  message: string | null;
};

/** Why a route is idle while the master switch is off, worded for the owner. */
export const AI_OFF_OWNER_MESSAGE = "AI is off platform-wide. Turn it on above.";

async function read<T>(operation: string, load: () => Promise<T>): Promise<LoadResult<T>> {
  try {
    return { status: "ready", value: await load() };
  } catch {
    // Operation names are static application context. Never log SQL, parameters or credentials.
    console.error("[control-panel] Configuration read unavailable", { operation });
    return { status: "unavailable" };
  }
}

/** Load each source independently, preserving successful settings when a sibling fails. */
export async function loadControlPanel() {
  const [master, sections, configs, wiring, identity] = await Promise.all([
    read("master", aiSwitch),
    read("sections", async () => (await storedAiSections()).sections),
    read("routes", () => routeConfigs({ preserveStored: true })),
    read("wiring", stageWiring),
    read("identity", sessionContext),
  ]);
  // A failed identity lookup must not trigger a second lookup or authorize any mutation.
  const owner = identity.status === "ready"
    ? await read("owner", () => ownerAccess(identity.value, { requireConfirmedLookup: true }))
    : { status: "unavailable" as const };
  // Interpret the confirmed snapshot once for runtime consequences, retaining raw saved values.
  const runtimeConfigs = configs.status === "ready"
    ? { status: "ready" as const, value: configs.value.map(normalizeRouteConfig) }
    : configs;
  const resolutions = Object.fromEntries(await Promise.all(STAGE_IDS.map(async stage => {
    const config = runtimeConfigs.status === "ready" ? runtimeConfigs.value.find(row => row.stage === stage) : undefined;
    if (master.status !== "ready" || !config) return [stage, { status: "unavailable" as const }];
    if (!master.value.enabled) return [stage, { status: "ready" as const, value: { state: "off", label: null, message: AI_OFF_OWNER_MESSAGE } }];
    const result = await read(`resolution:${stage}`, async (): Promise<RoutePreview> => {
      try {
        const route = await resolveRoute(stage, config);
        return {
          state: route.degraded ? "fallback" : "resolved",
          label: `${route.provider_label} · ${route.model}`,
          message: route.degraded ? "Using a fallback because the preferred provider is unavailable. Check the server API-key status above." : null,
        };
      } catch (error) {
        if (error instanceof NoRouteError) return {
          state: "no_provider", label: null,
          message: "No configured provider is available. Set a provider API key in the server environment, then retry.",
        };
        throw error;
      }
    });
    return [stage, result];
  }))) as Record<StageId, LoadResult<RoutePreview>>;
  return { master, sections, configs, runtimeConfigs, wiring, identity, owner, resolutions };
}
