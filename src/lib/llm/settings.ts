import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_COSTS,
  defaultLlmSettings,
  LLM_MODULES,
  LLM_PROVIDERS,
  type LlmModuleId,
  type LlmProviderId,
  type LlmRoute,
  type LlmSettings,
} from "./catalog";

let memory: LlmSettings | null = null;
let localWrite = false;

function settingsPath(): string {
  return process.env.LLM_SETTINGS_PATH?.trim() || join(process.cwd(), "data/runtime/llm-settings.json");
}

export function mergeSettings(raw: Partial<LlmSettings> | null | undefined): LlmSettings {
  const base = defaultLlmSettings();
  const routes = { ...base.routes };
  for (const moduleId of LLM_MODULES) {
    const incoming = raw?.routes?.[moduleId];
    if (!incoming) continue;
    const provider = LLM_PROVIDERS.includes(incoming.provider as LlmProviderId)
      ? (incoming.provider as LlmProviderId)
      : routes[moduleId].provider;
    const model = incoming.model?.trim() || routes[moduleId].model;
    routes[moduleId] = { provider, model };
  }
  return {
    routes,
    costs: { ...DEFAULT_COSTS, ...base.costs, ...raw?.costs },
    provider_defaults: {
      ...base.provider_defaults,
      ...raw?.provider_defaults,
    },
  };
}

export function getLlmSettings(): LlmSettings {
  if (memory) return memory;
  try {
    const path = settingsPath();
    if (existsSync(path)) {
      memory = mergeSettings(JSON.parse(readFileSync(path, "utf8")) as Partial<LlmSettings>);
      return memory;
    }
  } catch {
    // fall through
  }
  memory = defaultLlmSettings();
  return memory;
}

export function setLlmSettings(next: LlmSettings): LlmSettings {
  memory = mergeSettings(next);
  localWrite = true;
  if (process.env.AGENTIC_TRACKING !== "memory" || process.env.LLM_SETTINGS_PATH) {
    try {
      const path = settingsPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
    } catch {
      // best-effort
    }
  }
  void persistSettingsDb(memory);
  return memory;
}

export function patchLlmSettings(patch: Partial<LlmSettings>): LlmSettings {
  const current = getLlmSettings();
  return setLlmSettings({
    ...current,
    ...patch,
    routes: { ...current.routes, ...patch.routes },
    costs: { ...current.costs, ...patch.costs },
    provider_defaults: { ...current.provider_defaults, ...patch.provider_defaults },
  });
}

export function routeForModule(moduleId: LlmModuleId): LlmRoute {
  return getLlmSettings().routes[moduleId];
}

export function resetLlmSettings() {
  memory = null;
  localWrite = false;
}

/** Prefer Postgres `llm_settings` when available; otherwise file / defaults. */
export async function loadLlmSettings(): Promise<LlmSettings> {
  if (memory && localWrite) return memory;
  if (!(process.env.VITEST && process.env.AGENTIC_TRACKING_DB !== "1")) {
    try {
      const { db, ensureSchema } = await import("@/lib/iegp/db");
      const t = await import("@/lib/iegp/schema");
      await ensureSchema();
      const rows = await db().select().from(t.llmSettings).limit(1);
      const config = rows[0]?.config as Partial<LlmSettings> | undefined;
      if (config) {
        memory = mergeSettings(config);
        return memory;
      }
    } catch {
      // fall through to file
    }
  }
  return getLlmSettings();
}

async function persistSettingsDb(settings: LlmSettings) {
  if (process.env.VITEST && process.env.AGENTIC_TRACKING_DB !== "1") return;
  try {
    const { db, ensureSchema } = await import("@/lib/iegp/db");
    const t = await import("@/lib/iegp/schema");
    await ensureSchema();
    await db()
      .insert(t.llmSettings)
      .values({
        id: "default",
        updated_at: new Date().toISOString(),
        config: settings,
      })
      .onConflictDoUpdate({
        target: t.llmSettings.id,
        set: { updated_at: new Date().toISOString(), config: settings },
      });
  } catch {
    // best-effort
  }
}
