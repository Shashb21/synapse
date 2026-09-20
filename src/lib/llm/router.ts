import { randomUUID } from "node:crypto";
import { agenticGateway } from "@/lib/llm/agentic/gateway";
import { previewText, recordAgenticCall } from "@/lib/llm/agentic/tracking";
import type { AgenticCallRecord, AgenticCompleteArgs, AgenticPurpose } from "@/lib/llm/agentic/types";
import {
  DEFAULT_MODELS,
  estimateCostUsd,
  isLlmModuleId,
  isLlmProviderId,
  moduleForPurpose,
  providerLoginHint,
  type LlmModuleId,
  type LlmProviderId,
  type LlmRoute,
  type LlmSettings,
} from "@/lib/llm/catalog";
import { completeGrok, completeOpenRouter } from "@/lib/llm/providers/openai-chat";
import { providerReady, hasAgenticLlm as anyProviderReady } from "@/lib/llm/ready";
import { getLlmSettings, loadLlmSettings } from "@/lib/llm/settings";

export type LlmRouterDeps = {
  completeClaude?: (args: AgenticCompleteArgs) => Promise<unknown>;
  completeGrok?: typeof completeGrok;
  completeOpenRouter?: typeof completeOpenRouter;
  settings?: () => LlmSettings | Promise<LlmSettings>;
  record?: (record: AgenticCallRecord) => Promise<void> | void;
  now?: () => number;
  providerReady?: (provider: LlmProviderId) => boolean;
};

let deps: LlmRouterDeps = {};

export function setLlmRouterDeps(next: LlmRouterDeps | null) {
  deps = next ?? {};
}

function inferPurpose(system: string, explicit?: AgenticPurpose): AgenticPurpose {
  if (explicit) return explicit;
  if (system.includes("You are the critic")) return "critic";
  if (system.includes("You are the judge")) return "judge";
  if (system.includes("You are the improver")) return "improver";
  return "generic";
}

async function settings(): Promise<LlmSettings> {
  if (deps.settings) return deps.settings();
  return loadLlmSettings();
}

function ready(provider: LlmProviderId): boolean {
  return (deps.providerReady ?? providerReady)(provider);
}

function now() {
  return deps.now?.() ?? Date.now();
}

export function resolveRoute(
  args: AgenticCompleteArgs,
  cfg: LlmSettings,
): { module: LlmModuleId; purpose: AgenticPurpose; route: LlmRoute } {
  const purpose = inferPurpose(args.system, args.purpose);
  const moduleId = isLlmModuleId(args.module) ? args.module : moduleForPurpose(purpose);
  const routed = cfg.routes[moduleId];
  const override = isLlmProviderId(args.provider) ? args.provider : null;
  const provider = override ?? routed.provider;
  const model =
    args.model?.trim() ||
    (override ? cfg.provider_defaults[override]?.model || DEFAULT_MODELS[override] : routed.model);
  return { module: moduleId, purpose, route: { provider, model } };
}

async function trackExternal(record: AgenticCallRecord) {
  await (deps.record ?? recordAgenticCall)(record);
}

export async function completeJson(args: AgenticCompleteArgs): Promise<unknown> {
  const cfg = await settings();
  const { module, purpose, route } = resolveRoute(args, cfg);
  const started = now();
  const requestId = randomUUID();
  const recordBase = (): Omit<AgenticCallRecord, "ok" | "latency_ms"> => ({
    id: `LLM-${randomUUID().slice(0, 8)}`,
    at: new Date(now()).toISOString(),
    auth_mode: "oauth",
    provider: route.provider,
    module,
    model: route.model,
    purpose,
    request_id: requestId,
    system_chars: args.system.length,
    user_chars: args.user.length,
    system_preview: previewText(args.system),
    user_preview: previewText(args.user),
  });

  if (!ready(route.provider)) {
    const error = providerLoginHint(route.provider, module);
    await trackExternal({
      ...recordBase(),
      ok: false,
      latency_ms: Math.max(0, now() - started),
      error,
    });
    throw new Error(error);
  }

  if (route.provider === "claude_code") {
    const complete = deps.completeClaude ?? ((next) => agenticGateway.completeJson(next));
    return complete({ ...args, purpose, module, model: route.model, provider: "claude_code" });
  }

  try {
    const input = {
      system: args.system,
      user: args.user,
      model: route.model,
      maxTokens: args.maxTokens,
      baseUrl: cfg.provider_defaults[route.provider]?.base_url,
    };
    const result =
      route.provider === "grok"
        ? await (deps.completeGrok ?? completeGrok)(input)
        : await (deps.completeOpenRouter ?? completeOpenRouter)(input);
    const cost_usd = estimateCostUsd(
      route.model,
      result.input_tokens,
      result.output_tokens,
      cfg.costs,
    );
    await trackExternal({
      ...recordBase(),
      ok: true,
      http_status: result.http_status,
      latency_ms: Math.max(0, now() - started),
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      cost_usd,
    });
    return result.json;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider call failed";
    await trackExternal({
      ...recordBase(),
      ok: false,
      latency_ms: Math.max(0, now() - started),
      error: message,
    });
    throw error instanceof Error ? error : new Error(message);
  }
}

export function hasAgenticLlm(moduleId?: LlmModuleId): boolean {
  return anyProviderReady(moduleId);
}

export { resolveRoute as resolveLlmRoute };
