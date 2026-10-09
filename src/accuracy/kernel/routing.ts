import { accuracyDb, ensureAccuracySchema } from "../store/db";
import * as t from "../store/schema";
import { nowIso } from "@/modules/kernel/ids";
import {
  AGENT_ROLES,
  CALL_KINDS,
  CALL_KINDS_META,
  type AgentRole,
  type CallKind,
  type JsonCompletion,
  type ResolvedAccuracyRoute,
  type RunHandle,
} from "./contracts";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { missingKeyReason, providerApiKey, providerConfigured } from "@/modules/llm/api-keys";
import {
  DEFAULT_ROUTE_FALLBACKS,
  DEFAULT_ROUTE_PROVIDER,
  NoRouteError,
  findProvider,
  servedModel,
} from "@/modules/llm/provider";
import { estimateCostUsd, usageFromMessages } from "./cost";
import { DEFAULT_MAX_TOKENS } from "@/modules/kernel/routing";
import { isTestStub } from "@/modules/kernel/llm";
import { executionFingerprint, type CompletionIdentity } from "./execution-identity";
import { newId } from "@/modules/kernel/ids";
import { redactSecrets } from "@/modules/llm/provider-error";

/**
 * Whether an Anthropic workspace id is set. Optional: only an org-scoped key
 * needs one, and the Claude provider sends it when it is set (KAN-65).
 */
export function anthropicWorkspaceConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_WORKSPACE_ID?.trim());
}

/** Live LLM needs the provider's env API key; every provider's key is enough on its own. */
export function accuracyAuthAllowsLive(_provider_id: string, auth: "api_key" | "none"): boolean {
  return auth === "api_key";
}

export type AccuracyRouteConfig = {
  call_kind: CallKind;
  agent_role: AgentRole | "none";
  provider_id: string;
  model: string;
  params: { temperature: number; max_tokens: number };
  fallbacks: string[];
  updated_by: string;
  updated_at: string;
};

function defaultConfig(call_kind: CallKind, agent_role: AgentRole | "none"): AccuracyRouteConfig {
  const provider = findProvider(DEFAULT_ROUTE_PROVIDER)!;
  return {
    call_kind,
    agent_role,
    provider_id: DEFAULT_ROUTE_PROVIDER,
    model: provider.default_model,
    params: { temperature: 0, max_tokens: DEFAULT_MAX_TOKENS },
    fallbacks: [...DEFAULT_ROUTE_FALLBACKS],
    updated_by: "default (Grok → Claude → OpenAI)",
    updated_at: "—",
  };
}

export async function accuracyRouteConfigs(): Promise<AccuracyRouteConfig[]> {
  await ensureAccuracySchema();
  const rows = await accuracyDb().select().from(t.accuracyRoutingConfig);
  const out: AccuracyRouteConfig[] = [];
  for (const kind of CALL_KINDS) {
    const meta = CALL_KINDS_META[kind];
    const roles: (AgentRole | "none")[] =
      meta.llm_roles.length === 0 ? ["none"] : [...meta.llm_roles];
    for (const role of roles) {
      const row = rows.find((r) => r.call_kind === kind && r.agent_role === role);
      if (!row) {
        out.push(defaultConfig(kind, role));
        continue;
      }
      const stored = row as unknown as AccuracyRouteConfig;
      const provider = findProvider(stored.provider_id);
      // A model the provider no longer lists reads as its default (KAN-65).
      out.push(provider ? { ...stored, model: servedModel(provider, stored.model) } : stored);
    }
  }
  return out;
}

export async function accuracyRouteConfig(
  call_kind: CallKind,
  agent_role: AgentRole | "none" = "proposer",
): Promise<AccuracyRouteConfig> {
  const configs = await accuracyRouteConfigs();
  return (
    configs.find((c) => c.call_kind === call_kind && c.agent_role === agent_role) ??
    defaultConfig(call_kind, agent_role)
  );
}

export async function setAccuracyRouteConfig(args: {
  call_kind: CallKind;
  agent_role: AgentRole | "none";
  provider_id: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  fallbacks?: string[];
  actor_name: string;
}): Promise<AccuracyRouteConfig> {
  await ensureAccuracySchema();
  const provider = findProvider(args.provider_id);
  if (!provider) throw new Error(`Unknown provider ${args.provider_id}`);
  const values = {
    call_kind: args.call_kind,
    agent_role: args.agent_role,
    provider_id: args.provider_id,
    model: args.model || provider.default_model,
    params: {
      temperature: args.temperature ?? 0,
      max_tokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
    },
    fallbacks: args.fallbacks?.length ? args.fallbacks : [...DEFAULT_ROUTE_FALLBACKS],
    updated_by: args.actor_name,
    updated_at: nowIso(),
  };
  await accuracyDb()
    .insert(t.accuracyRoutingConfig)
    .values(values)
    .onConflictDoUpdate({
      target: [t.accuracyRoutingConfig.call_kind, t.accuracyRoutingConfig.agent_role],
      set: values,
    });
  return { ...values, params: values.params as AccuracyRouteConfig["params"] };
}

export async function resolveAccuracyRoute(args: {
  call_kind: CallKind;
  agent_role: AgentRole | "none";
}): Promise<ResolvedAccuracyRoute> {
  const config = await accuracyRouteConfig(args.call_kind, args.agent_role);
  if (config.agent_role === "none" && CALL_KINDS_META[args.call_kind].llm_roles.length === 0) {
    const provider = findProvider(DEFAULT_ROUTE_PROVIDER)!;
    return {
      call_kind: args.call_kind,
      role: "none",
      provider_id: provider.id,
      provider_label: provider.label,
      model: config.model,
      auth: "none",
      connected: false,
      params: config.params,
      fallbacks: config.fallbacks,
      degraded: false,
      reason: "mechanical_kind",
    };
  }
  const candidates = [config.provider_id, ...config.fallbacks];
  const reasons: string[] = [];
  for (const [index, id] of candidates.entries()) {
    const provider = findProvider(id);
    if (!provider || provider.auth === "none") continue;
    if (!providerConfigured(provider)) {
      reasons.push(missingKeyReason(provider));
      continue;
    }
    if (!accuracyAuthAllowsLive(provider.id, "api_key")) {
      reasons.push(`${provider.label}: not usable for live LLM`);
      continue;
    }
    return {
      call_kind: args.call_kind,
      role: args.agent_role === "none" ? "proposer" : args.agent_role,
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
    `${reasons.length ? `${reasons.join("; ")}. ` : ""}Set the provider's API key in the server environment, then retry.`,
  );
}

export function accuracyCompletionFor(args: {
  route: ResolvedAccuracyRoute;
  run: RunHandle;
  onUsage: (usage: ReturnType<typeof usageFromMessages>, cost_usd: number) => void;
}): JsonCompletion {
  return async ({ system, user, purpose, maxTokens }) => {
    if (args.route.auth !== "api_key" || !args.route.connected) {
      throw new NoRouteError(`No LLM route for ${purpose}`);
    }
    const provider = findProvider(args.route.provider_id)!;
    // Read at call time and handed straight to the provider; never logged or traced.
    const api_key = providerApiKey(args.route.provider_id);
    if (!api_key) throw new NoRouteError(missingKeyReason(provider));
    const identity: CompletionIdentity = { completion_id: newId("completion"), purpose,
      system_fingerprint: executionFingerprint(system), user_fingerprint: executionFingerprint(user),
      provider_id: args.route.provider_id, configured_model: args.route.model, temperature: args.route.params.temperature,
      max_tokens: maxTokens ?? args.route.params.max_tokens, response_model: null, provider_revision: null, status: "started" };
    args.run.note("llm:completion:started", { ...identity });
    await args.run.checkpointExecution?.();
    let raw: string;
    try {
      raw = await args.run.step(
        `llm:${args.route.role}:${purpose}`,
        () => provider.complete({ system, user, model: args.route.model, temperature: args.route.params.temperature,
          max_tokens: maxTokens ?? args.route.params.max_tokens,
          onResponseIdentity: response => { Object.assign(identity, response); },
        }, { api_key }).catch(error => {
          if (error instanceof Error) { error.message = redactSecrets(error.message, [api_key]); throw error; }
          throw new Error(redactSecrets(String(error), [api_key]));
        }),
        `${args.route.provider_label} · ${args.route.model}`,
      );
    } catch (error) {
      args.run.note("llm:completion:finished", { ...identity, status: "failed" });
      await args.run.checkpointExecution?.();
      throw error;
    }
    args.run.note("llm:completion:finished", { ...identity, status: "succeeded" });
    const usage = usageFromMessages(system, user, raw);
    const { cost_usd } = estimateCostUsd({
      provider_id: args.route.provider_id,
      model: args.route.model,
      usage,
    });
    args.onUsage(usage, cost_usd);
    await args.run.checkpointExecution?.();
    return { raw, usage };
  };
}

/**
 * Throws unless this route can prompt a model (or the test stub is on). Accuracy
 * modules call it before any judgement; there is no rule-based fallback.
 */
export function requireAccuracyLlm(
  route: Pick<ResolvedAccuracyRoute, "connected" | "auth">,
  what: string,
): void {
  if (isTestStub()) return;
  if (route.connected && route.auth === "api_key") return;
  throw new NoRouteError(
    `${what} needs a live LLM. Set XAI_API_KEY or ANTHROPIC_API_KEY in the server environment and run it again.`,
  );
}

/** Parse JSON from completion when module expects structured output. */
export async function completeJson(
  complete: JsonCompletion,
  args: { system: string; user: string; purpose: string },
): Promise<unknown> {
  const { raw } = await complete(args);
  return extractJsonObject(raw);
}

export async function setAccuracyDefaultProvider(args: {
  provider_id: string;
  actor_name: string;
  model?: string;
}) {
  const provider = findProvider(args.provider_id);
  if (!provider) throw new Error(`Unknown provider ${args.provider_id}`);
  const out: AccuracyRouteConfig[] = [];
  for (const kind of CALL_KINDS) {
    const meta = CALL_KINDS_META[kind];
    if (meta.llm_roles.length === 0) continue;
    for (const role of meta.llm_roles) {
      out.push(
        await setAccuracyRouteConfig({
          call_kind: kind,
          agent_role: role,
          provider_id: args.provider_id,
          model: args.model ?? provider.default_model,
          actor_name: args.actor_name,
        }),
      );
    }
  }
  return out;
}

export function allRoutableRoles(): { call_kind: CallKind; agent_role: AgentRole }[] {
  const pairs: { call_kind: CallKind; agent_role: AgentRole }[] = [];
  for (const kind of CALL_KINDS) {
    for (const role of CALL_KINDS_META[kind].llm_roles) {
      pairs.push({ call_kind: kind, agent_role: role });
    }
  }
  return pairs;
}

void AGENT_ROLES;
