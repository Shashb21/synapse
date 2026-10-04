import { ensurePlatformSchema, sharedDb } from "./db";
import { AI_OFF_MESSAGE, aiEnabled } from "./ai-switch";
import * as t from "./schema";
import { nowIso } from "./ids";
import { STAGES, STAGE_IDS, type JsonCompletion, type ResolvedRoute, type RunHandle, type StageId } from "./contracts";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { missingKeyReason, providerApiKey, providerConfigured } from "@/modules/llm/api-keys";
import {
  DEFAULT_ROUTE_FALLBACKS,
  DEFAULT_ROUTE_PROVIDER,
  NoRouteError,
  findProvider,
  providerServes,
  servedModel,
} from "@/modules/llm/provider";

/**
 * Output budget for one model call when a route sets none (KAN-66). Thinking models
 * count it toward their reasoning, and S4/S9 replies are long.
 */
export const DEFAULT_MAX_TOKENS = 16000;

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

/** The bounds a route's parameters must sit inside (KAN-63). */
export const ROUTE_LIMITS = {
  temperature: { min: 0, max: 2 },
  max_tokens: { min: 1, max: 200_000 },
} as const;

/** Only stages that call a model have a route; mechanical and human stages do not. */
export function stageHasRoute(stage: StageId): boolean {
  return STAGES[stage].kind === "agentic";
}

/**
 * A route parameter from a request body. Blank (missing, null or "") means
 * "keep the current value"; anything else must be a number inside the bounds.
 */
export function parseRouteParam(value: unknown, field: keyof typeof ROUTE_LIMITS): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  const { min, max } = ROUTE_LIMITS[field];
  if (field === "max_tokens") {
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`Max tokens must be a whole number from ${min} to ${max.toLocaleString("en-US")}.`);
    }
  } else if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`Temperature must be a number from ${min} to ${max}.`);
  }
  return number;
}

/**
 * A route's fallbacks from a request body: a comma-separated string or an
 * array. Blank means "no fallbacks". Unknown providers and the stage's own
 * provider are refused; repeats are dropped.
 */
export function parseFallbacks(value: unknown, provider_id: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  let ids: string[];
  if (typeof value === "string") ids = value.split(",");
  else if (Array.isArray(value) && value.every((id) => typeof id === "string")) ids = value;
  else throw new Error("Fallbacks must be a comma-separated list of provider ids.");
  const out: string[] = [];
  for (const id of ids.map((candidate) => candidate.trim()).filter(Boolean)) {
    if (!findProvider(id)) throw new Error(`Unknown fallback provider ${id}`);
    if (id === provider_id) throw new Error(`${id} is this stage's provider, so it cannot also be its fallback.`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function defaultConfig(stage: StageId): RouteConfig {
  return {
    stage,
    provider_id: DEFAULT_PROVIDER_ID,
    model: findProvider(DEFAULT_PROVIDER_ID)?.default_model ?? "grok-4",
    params: { temperature: 0, max_tokens: DEFAULT_MAX_TOKENS },
    fallbacks: DEFAULT_FALLBACKS,
    updated_by: "default (locked: Grok)",
    updated_at: "—",
  };
}

export async function routeConfigs(): Promise<RouteConfig[]> {
  await ensurePlatformSchema();
  const rows = await sharedDb().select().from(t.routingConfig);
  return STAGE_IDS.map((stage) => {
    const row = rows.find((candidate) => candidate.stage === stage);
    if (!row) return defaultConfig(stage);
    const provider_id = row.provider_id === LEGACY_OFFLINE_PROVIDER ? DEFAULT_PROVIDER_ID : row.provider_id;
    const provider = findProvider(provider_id);
    return {
      stage,
      provider_id,
      // A model the provider no longer lists reads as its default (KAN-65).
      model: provider ? servedModel(provider, row.model) : row.model,
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

type RouteInput = {
  stage: StageId;
  provider_id: string;
  model: string;
  /** Undefined keeps the stage's current value. */
  temperature?: number;
  max_tokens?: number;
  /** Undefined keeps the current chain; [] means no fallbacks. */
  fallbacks?: string[];
  actor_name: string;
};

/** One stage's route. Mechanical and human stages have none, so they are refused. */
export async function setRouteConfig(args: RouteInput): Promise<RouteConfig> {
  if (!stageHasRoute(args.stage)) {
    throw new Error(`${args.stage} does not call a model, so it has no route to set.`);
  }
  return writeRouteConfig(args);
}

async function writeRouteConfig(args: RouteInput): Promise<RouteConfig> {
  await ensurePlatformSchema();
  if (args.provider_id === LEGACY_OFFLINE_PROVIDER) {
    throw new Error("Deterministic / no-LLM routing was removed. Pick a cloud provider.");
  }
  const provider = findProvider(args.provider_id);
  if (!provider) throw new Error(`Unknown provider ${args.provider_id}`);
  if (args.model && !providerServes(provider, args.model)) {
    throw new Error(`${provider.label} does not serve ${args.model}`);
  }
  if (args.temperature !== undefined) parseRouteParam(args.temperature, "temperature");
  if (args.max_tokens !== undefined) parseRouteParam(args.max_tokens, "max_tokens");
  const fallbacks = args.fallbacks === undefined ? undefined : parseFallbacks(args.fallbacks, args.provider_id);
  const current = await routeConfig(args.stage);
  const values = {
    stage: args.stage,
    provider_id: args.provider_id,
    model: args.model || provider.default_model,
    params: {
      temperature: args.temperature ?? current.params.temperature,
      max_tokens: args.max_tokens ?? current.params.max_tokens,
    },
    // A kept chain drops the new provider, which cannot fall back to itself.
    fallbacks: scrubFallbacks(fallbacks ?? current.fallbacks.filter((id) => id !== args.provider_id)),
    updated_by: args.actor_name,
    updated_at: nowIso(),
  };
  await sharedDb()
    .insert(t.routingConfig)
    .values(values)
    .onConflictDoUpdate({ target: t.routingConfig.stage, set: values });
  return { ...values, stage: args.stage, params: values.params as RouteConfig["params"] };
}

const KEY_PROMPT =
  "Set the provider's API key in the server environment (.env.local or your host's settings), then retry.";

/**
 * Turns the control-panel configuration into the route a run will actually use.
 * Every resolved route is an LLM whose API key is set; there is no offline fallback.
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
    if (!providerConfigured(provider)) {
      reasons.push(missingKeyReason(provider));
      continue;
    }
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: index === 0 ? config.model : provider.default_model,
      auth: "api_key",
      connected: true,
      params: config.params,
      fallbacks: config.fallbacks,
      degraded: index > 0,
      reason: reasons.length ? reasons.join("; ") : null,
    };
  }
  throw new NoRouteError(
    reasons.length ? `${reasons.join("; ")}. ${KEY_PROMPT}` : KEY_PROMPT,
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
    // Every stage, so "routed to" names one provider across the board (KAN-60).
    out.push(
      await writeRouteConfig({
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
  return route.auth === "api_key" && route.connected;
}

/** Builds the JSON completion the module receives, bound to route + run trace. */
export function completionFor(route: ResolvedRoute, run: RunHandle): JsonCompletion {
  return async ({ system, user, purpose, maxTokens }) => {
    if (!canPrompt(route)) {
      throw new NoRouteError(`${route.provider_label} cannot serve ${purpose}. ${KEY_PROMPT}`);
    }
    const provider = findProvider(route.provider_id)!;
    // Read at call time and handed straight to the provider; never logged or traced.
    const api_key = providerApiKey(route.provider_id);
    if (!api_key) throw new NoRouteError(`${missingKeyReason(provider)}. ${KEY_PROMPT}`);
    let invalid: string | null = null;
    for (let attempt = 1; attempt <= JSON_REPLY_ATTEMPTS; attempt += 1) {
      const text = await run.step(
        `llm:${purpose}`,
        () =>
          provider.complete(
            {
              // A reply that wasn't valid JSON is asked for again, saying why (KAN-66).
              system: invalid ? `${system}\n\n${invalidJsonNote(invalid)}` : system,
              user,
              model: route.model,
              temperature: route.params.temperature,
              max_tokens: maxTokens ?? route.params.max_tokens,
            },
            { api_key },
          ),
        `${route.provider_label} · ${route.model}`,
      );
      try {
        return extractJsonObject(text);
      } catch (error) {
        invalid = error instanceof Error ? error.message : String(error);
        run.note(`llm:${purpose}:invalid-json`, { attempt, error: invalid });
      }
    }
    throw new Error(
      `${route.provider_label} did not return valid JSON for ${purpose} after ${JSON_REPLY_ATTEMPTS} attempts (${invalid}). Nothing was saved; try again.`,
    );
  };
}

/** How many times one model call is asked for again when its reply is not valid JSON. */
export const JSON_REPLY_ATTEMPTS = 3;

export function invalidJsonNote(error: string): string {
  return `Your previous reply was not valid JSON (${error}). Reply with exactly one valid JSON object and nothing else: escape every double quote inside strings, and put a comma between array elements.`;
}

export function stageLabel(stage: StageId): string {
  return STAGES[stage].title;
}

/**
 * UI preview when no provider has a key yet (does not throw). `ai` overrides
 * the effective switch: the control panel passes the platform master switch.
 */
export async function previewRoute(stage: StageId, ai?: boolean): Promise<ResolvedRoute> {
  try {
    // The preview says why nothing will be prompted when AI is off.
    if (!(ai ?? (await aiEnabled().catch(() => true)))) throw new Error(AI_OFF_MESSAGE);
    return await resolveRoute(stage);
  } catch (error) {
    let config = defaultConfig(stage);
    try {
      config = await routeConfig(stage);
    } catch {
      // Postgres / platform schema may not be ready yet.
    }
    const provider =
      findProvider(config.provider_id) ?? findProvider(DEFAULT_PROVIDER_ID)!;
    const message = error instanceof Error ? error.message : KEY_PROMPT;
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: config.model || provider.default_model,
      auth: provider.auth,
      connected: false,
      params: config.params,
      fallbacks: config.fallbacks,
      degraded: true,
      reason: message,
    };
  }
}
