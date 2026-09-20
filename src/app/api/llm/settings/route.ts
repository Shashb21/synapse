import { NextResponse } from "next/server";
import {
  DEFAULT_COSTS,
  DEFAULT_MODELS,
  LLM_MODULES,
  LLM_PROVIDERS,
  MODULE_LABELS,
  PROVIDER_LABELS,
  defaultLlmSettings,
  isLlmModuleId,
  isLlmProviderId,
  type LlmCostRate,
  type LlmModuleId,
  type LlmProviderId,
  type LlmSettings,
} from "@/lib/llm/catalog";
import { loadLlmSettings, patchLlmSettings, resetLlmSettings, setLlmSettings } from "@/lib/llm/settings";

export const runtime = "nodejs";

function catalog() {
  return {
    providers: LLM_PROVIDERS,
    modules: LLM_MODULES,
    provider_labels: PROVIDER_LABELS,
    module_labels: MODULE_LABELS,
    default_models: DEFAULT_MODELS,
    default_costs: DEFAULT_COSTS,
  };
}

function parseRoutes(
  raw: unknown,
  current: LlmSettings,
): Partial<LlmSettings["routes"]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const routes: Partial<LlmSettings["routes"]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, { provider?: string; model?: string }>)) {
    if (!isLlmModuleId(key) || !value || typeof value !== "object") continue;
    const provider = isLlmProviderId(value.provider) ? value.provider : current.routes[key].provider;
    const model = typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : current.routes[key].model;
    routes[key as LlmModuleId] = { provider, model };
  }
  return Object.keys(routes).length ? routes : undefined;
}

function parseCosts(raw: unknown): Record<string, LlmCostRate> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const costs: Record<string, LlmCostRate> = {};
  for (const [model, value] of Object.entries(raw as Record<string, { input_per_mtok?: unknown; output_per_mtok?: unknown }>)) {
    const name = model.trim();
    if (!name || !value || typeof value !== "object") continue;
    const input = Number(value.input_per_mtok);
    const output = Number(value.output_per_mtok);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      throw new Error(`Invalid cost for ${name}: input_per_mtok and output_per_mtok must be >= 0.`);
    }
    costs[name] = { input_per_mtok: input, output_per_mtok: output, currency: "USD" };
  }
  return costs;
}

function parseDefaults(raw: unknown): LlmSettings["provider_defaults"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const defaults = {} as LlmSettings["provider_defaults"];
  let any = false;
  for (const [key, value] of Object.entries(
    raw as Record<string, { model?: string; base_url?: string }>,
  )) {
    if (!isLlmProviderId(key) || !value || typeof value !== "object") continue;
    const model = typeof value.model === "string" ? value.model.trim() : "";
    const base_url = typeof value.base_url === "string" ? value.base_url.trim() : undefined;
    if (!model && !base_url) continue;
    defaults[key as LlmProviderId] = {
      model: model || DEFAULT_MODELS[key as LlmProviderId],
      base_url,
    };
    any = true;
  }
  return any ? defaults : undefined;
}

export async function GET() {
  const settings = await loadLlmSettings();
  return NextResponse.json({ ok: true, settings, catalog: catalog() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.reset === true) {
      resetLlmSettings();
      const settings = setLlmSettings(defaultLlmSettings());
      return NextResponse.json({ ok: true, settings, catalog: catalog() });
    }
    const current = await loadLlmSettings();
    const patch: Partial<LlmSettings> = {};
    const routes = parseRoutes(body.routes, current);
    if (routes) patch.routes = routes as LlmSettings["routes"];
    if (body.costs !== undefined) patch.costs = parseCosts(body.costs);
    const defaults = parseDefaults(body.provider_defaults);
    if (defaults) patch.provider_defaults = defaults;
    const settings = patchLlmSettings(patch);
    return NextResponse.json({ ok: true, settings, catalog: catalog() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save LLM settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
