import { eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "./db";
import * as t from "./schema";
import { nowIso } from "./ids";
import { STAGES, STAGE_IDS, type JsonCompletion, type ResolvedRoute, type RunHandle, type StageId } from "./contracts";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { accessToken, connectionStatus } from "@/modules/llm/oauth";
import { NoRouteError, findProvider, providerConfigured } from "@/modules/llm/provider";

export const DEFAULT_PROVIDER_ID = "deterministic-local";

export type RouteConfig = {
  stage: StageId;
  provider_id: string;
  model: string;
  params: { temperature: number; max_tokens: number };
  fallbacks: string[];
  updated_by: string;
  updated_at: string;
};

function defaultConfig(stage: StageId): RouteConfig {
  return {
    stage,
    provider_id: DEFAULT_PROVIDER_ID,
    model: "local-heuristic",
    params: { temperature: 0, max_tokens: 8192 },
    fallbacks: [DEFAULT_PROVIDER_ID],
    updated_by: "default",
    updated_at: "—",
  };
}

export async function routeConfigs(): Promise<RouteConfig[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.routingConfig);
  return STAGE_IDS.map((stage) => {
    const row = rows.find((candidate) => candidate.stage === stage);
    if (!row) return defaultConfig(stage);
    return {
      stage,
      provider_id: row.provider_id,
      model: row.model,
      params: row.params as RouteConfig["params"],
      fallbacks: (row.fallbacks as string[]) ?? [DEFAULT_PROVIDER_ID],
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    };
  });
}

export async function routeConfig(stage: StageId): Promise<RouteConfig> {
  const configs = await routeConfigs();
  return configs.find((config) => config.stage === stage) ?? defaultConfig(stage);
}

export async function setRouteConfig(args: {
  stage: StageId;
  provider_id: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  fallbacks?: string[];
  actor_name: string;
}): Promise<RouteConfig> {
  await ensurePlatformSchema();
  const provider = findProvider(args.provider_id);
  if (!provider) throw new Error(`Unknown provider ${args.provider_id}`);
  if (args.model && provider.models.length > 0 && !provider.models.includes(args.model)) {
    throw new Error(`${provider.label} does not serve ${args.model}`);
  }
  const values = {
    stage: args.stage,
    provider_id: args.provider_id,
    model: args.model || provider.default_model,
    params: {
      temperature: args.temperature ?? 0,
      max_tokens: args.max_tokens ?? 8192,
    },
    fallbacks: args.fallbacks?.length ? args.fallbacks : [DEFAULT_PROVIDER_ID],
    updated_by: args.actor_name,
    updated_at: nowIso(),
  };
  await db()
    .insert(t.routingConfig)
    .values(values)
    .onConflictDoUpdate({ target: t.routingConfig.stage, set: values });
  return { ...values, stage: args.stage, params: values.params as RouteConfig["params"] };
}

/**
 * Turns the control-panel configuration into the route a run will actually use.
 * An unreachable preferred provider degrades along the configured fallbacks and
 * finally to the deterministic route, and says so.
 */
export async function resolveRoute(stage: StageId): Promise<ResolvedRoute> {
  const config = await routeConfig(stage);
  const candidates = [config.provider_id, ...config.fallbacks, DEFAULT_PROVIDER_ID];
  const reasons: string[] = [];
  for (const [index, id] of candidates.entries()) {
    const provider = findProvider(id);
    if (!provider) {
      reasons.push(`${id}: unknown provider`);
      continue;
    }
    if (provider.auth === "none") {
      return {
        stage,
        provider_id: provider.id,
        provider_label: provider.label,
        model: index === 0 ? config.model : provider.default_model,
        auth: "none",
        connected: false,
        params: config.params,
        fallbacks: config.fallbacks,
        degraded: index > 0,
        reason: reasons.length ? reasons.join("; ") : null,
      };
    }
    if (!providerConfigured(provider)) {
      reasons.push(`${provider.label}: OAuth client not configured`);
      continue;
    }
    const status = await connectionStatus(provider.id);
    if (status !== "connected") {
      reasons.push(`${provider.label}: ${status}`);
      continue;
    }
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: index === 0 ? config.model : provider.default_model,
      auth: "oauth",
      connected: true,
      params: config.params,
      fallbacks: config.fallbacks,
      degraded: index > 0,
      reason: reasons.length ? reasons.join("; ") : null,
    };
  }
  return {
    ...defaultRoute(stage),
    reason: reasons.join("; ") || "no provider available",
    degraded: true,
  };
}

export function defaultRoute(stage: StageId): ResolvedRoute {
  return {
    stage,
    provider_id: DEFAULT_PROVIDER_ID,
    provider_label: "Deterministic (no LLM)",
    model: "local-heuristic",
    auth: "none",
    connected: false,
    params: { temperature: 0, max_tokens: 8192 },
    fallbacks: [DEFAULT_PROVIDER_ID],
    degraded: false,
    reason: null,
  };
}

/** True when a stage may prompt a model on this route. */
export function canPrompt(route: ResolvedRoute): boolean {
  return route.auth === "oauth" && route.connected;
}

/** Builds the JSON completion the module receives, bound to route + run trace. */
export function completionFor(route: ResolvedRoute, run: RunHandle): JsonCompletion {
  return async ({ system, user, purpose, maxTokens }) => {
    if (!canPrompt(route)) {
      throw new NoRouteError(
        `${route.provider_label} cannot serve ${purpose}: connect it in the control panel`,
      );
    }
    const provider = findProvider(route.provider_id)!;
    const token = await accessToken(route.provider_id);
    if (!token) throw new NoRouteError(`${route.provider_label} has no usable access token`);
    const text = await run.step(
      `llm:${purpose}`,
      () =>
        provider.complete(
          {
            system,
            user,
            model: route.model,
            temperature: route.params.temperature,
            max_tokens: maxTokens ?? route.params.max_tokens,
          },
          { access_token: token },
        ),
      `${route.provider_label} · ${route.model}`,
    );
    return extractJsonObject(text);
  };
}

export function stageLabel(stage: StageId): string {
  return STAGES[stage].title;
}
