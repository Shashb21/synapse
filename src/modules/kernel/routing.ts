import { db, ensurePlatformSchema } from "./db";
import * as t from "./schema";
import { nowIso } from "./ids";
import { STAGES, STAGE_IDS, type JsonCompletion, type ResolvedRoute, type RunHandle, type StageId } from "./contracts";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { accessToken, authKindFor, connectionStatus } from "@/modules/llm/oauth";
import { hasProviderApiKey } from "@/modules/llm/api-keys";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_FALLBACKS,
  DEFAULT_ROUTE_PROVIDER,
  NoRouteError,
  findProvider,
  providerConfigured,
} from "@/modules/llm/provider";

/** Removed from the product; strip from stored fallbacks when resolving routes. */
const LEGACY_OFFLINE_PROVIDER = "deterministic-local";

/** Locked default: Grok. Claude then OpenAI are the standing alternates. */
export const DEFAULT_PROVIDER_ID = DEFAULT_ROUTE_PROVIDER;
export const DEFAULT_FALLBACKS = [...DEFAULT_ROUTE_FALLBACKS];

export type RouteConfig = {
  stage: StageId;
  provider_id: string;
  model: string;
  params: { temperature: number; max_tokens: number };
  fallbacks: string[];
  updated_by: string;
  updated_at: string;
};

function scrubFallbacks(ids: string[]): string[] {
  return ids.filter((id) => id !== LEGACY_OFFLINE_PROVIDER);
}

function defaultConfig(stage: StageId): RouteConfig {
  return {
    stage,
    provider_id: DEFAULT_PROVIDER_ID,
    model: findProvider(DEFAULT_PROVIDER_ID)?.default_model ?? "grok-4",
    params: { temperature: 0, max_tokens: 8192 },
    fallbacks: DEFAULT_FALLBACKS,
    updated_by: "default (locked: Grok)",
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
      provider_id: row.provider_id === LEGACY_OFFLINE_PROVIDER ? DEFAULT_PROVIDER_ID : row.provider_id,
      model: row.model,
      params: row.params as RouteConfig["params"],
      fallbacks: scrubFallbacks((row.fallbacks as string[]) ?? DEFAULT_FALLBACKS),
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
  if (args.provider_id === LEGACY_OFFLINE_PROVIDER) {
    throw new Error("Deterministic / no-LLM routing was removed. Pick a cloud provider.");
  }
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
    fallbacks: scrubFallbacks(args.fallbacks?.length ? args.fallbacks : DEFAULT_FALLBACKS),
    updated_by: args.actor_name,
    updated_at: nowIso(),
  };
  await db()
    .insert(t.routingConfig)
    .values(values)
    .onConflictDoUpdate({ target: t.routingConfig.stage, set: values });
  return { ...values, stage: args.stage, params: values.params as RouteConfig["params"] };
}

const CONNECT_PROMPT =
  "Connect an LLM provider in the control panel (/control) — log in with Grok, Claude, or another provider — then retry.";

/**
 * Turns the control-panel configuration into the route a run will actually use.
 * Every resolved route is a connected OAuth LLM; there is no offline fallback.
 */
export async function resolveRoute(stage: StageId): Promise<ResolvedRoute> {
  const config = await routeConfig(stage);
  const candidates = scrubFallbacks([config.provider_id, ...config.fallbacks]);
  const reasons: string[] = [];
  for (const [index, id] of candidates.entries()) {
    const provider = findProvider(id);
    if (!provider) {
      reasons.push(`${id}: unknown provider`);
      continue;
    }
    if (provider.auth === "none") {
      reasons.push(`${provider.label}: not an LLM provider`);
      continue;
    }
    const oauthReady = providerConfigured(provider);
    const keyReady = hasProviderApiKey(provider.id);
    if (!oauthReady && !keyReady) {
      reasons.push(`${provider.label}: OAuth client not available`);
      continue;
    }
    const status = await connectionStatus(provider.id);
    if (status !== "connected") {
      reasons.push(`${provider.label}: ${status}`);
      continue;
    }
    const authKind = (await authKindFor(provider.id)) ?? (keyReady ? "api_key" : "oauth");
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: index === 0 ? config.model : provider.default_model,
      auth: authKind,
      connected: true,
      params: config.params,
      fallbacks: config.fallbacks,
      degraded: index > 0,
      reason: reasons.length
        ? reasons.join("; ")
        : authKind === "api_key"
          ? "server API key"
          : null,
    };
  }
  throw new NoRouteError(
    reasons.length ? `${reasons.join("; ")}. ${CONNECT_PROMPT}` : CONNECT_PROMPT,
  );
}

/**
 * The locked one-click switch: point every stage at Grok or at Claude in a single
 * action, keeping the standing fallback chain (Claude / OpenAI / Grok as needed).
 */
export async function setDefaultProvider(args: {
  provider_id: string;
  actor_name: string;
  model?: string;
}): Promise<RouteConfig[]> {
  const provider = findProvider(args.provider_id);
  if (!provider) throw new Error(`Unknown provider ${args.provider_id}`);
  const chain = [DEFAULT_ROUTE_PROVIDER, ...DEFAULT_ROUTE_FALLBACKS];
  const fallbacks = chain.filter((id) => id !== args.provider_id);
  const out: RouteConfig[] = [];
  for (const stage of STAGE_IDS) {
    out.push(
      await setRouteConfig({
        stage,
        provider_id: args.provider_id,
        model: args.model ?? provider.default_model,
        fallbacks,
        actor_name: args.actor_name,
      }),
    );
  }
  return out;
}

/** True when a stage may prompt a model on this route. */
export function canPrompt(route: ResolvedRoute): boolean {
  return (route.auth === "oauth" || route.auth === "api_key") && route.connected;
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
          { access_token: token, kind: route.auth === "api_key" ? "api_key" : "oauth" },
        ),
      `${route.provider_label} · ${route.model}`,
    );
    return extractJsonObject(text);
  };
}

export function stageLabel(stage: StageId): string {
  return STAGES[stage].title;
}

/** UI preview when no provider is connected yet (does not throw). */
export async function previewRoute(stage: StageId): Promise<ResolvedRoute> {
  try {
    return await resolveRoute(stage);
  } catch (error) {
    const config = await routeConfig(stage);
    const provider =
      findProvider(config.provider_id) ?? findProvider(DEFAULT_PROVIDER_ID)!;
    const message = error instanceof Error ? error.message : String(error);
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: config.model || provider.default_model,
      auth: "oauth",
      connected: false,
      params: config.params,
      fallbacks: config.fallbacks,
      degraded: true,
      reason: message,
    };
  }
}
