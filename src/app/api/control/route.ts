import { NextResponse } from "next/server";
import "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { activateModule, stageWiring } from "@/modules/kernel/registry";
import {
  parseFallbacks,
  parseRouteParam,
  routeConfigs,
  setDefaultProvider,
  setRouteConfig,
} from "@/modules/kernel/routing";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  PROVIDERS,
} from "@/modules/llm/provider";
import { listProviderKeys } from "@/modules/llm/api-keys";
import { apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import { requestIdentity } from "@/modules/auth/request";
import { ownerAccess, ownerGate, ownerOnlyJson } from "@/modules/auth/owner";
import { beginLogin, loginOptions, signInDemo, signOut } from "@/modules/auth/session";
import { loadAxes, saveAxes } from "@/modules/stages/s8-prioritization/axes";
import { aiSwitch, setAiEnabled, setAiSection, storedAiSections } from "@/modules/kernel/ai-switch";
import { AI_SECTION_IDS, isAiSectionId } from "@/modules/kernel/ai-sections";
import { computePendingLessons } from "@/modules/kernel/decision-examples";
import { routeConfig } from "@/modules/kernel/routing";
import { recordAudit } from "@/modules/kernel/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform actions only the owner may take (the admin console at /admin/control).
 * Sign-in and sign-out stay open; the prioritization axes (save_axes) go
 * through the customer guard like every other customer write.
 */
const OWNER_ACTIONS = new Set([
  "set_ai_enabled",
  "set_ai_section",
  "set_ai_sections",
  "set_route",
  "set_default_provider",
  "activate_module",
  "compute_lessons",
]);

/**
 * Platform configuration (routes, provider key status, module wiring): owner only.
 * A provider's key status says only whether it is set and which env var it comes
 * from, never its value.
 */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  const [wiring, routes, axes, ai, sections] = await Promise.all([
    stageWiring(),
    routeConfigs(),
    loadAxes(),
    aiSwitch(),
    storedAiSections(),
  ]);
  return NextResponse.json({
    ai,
    ai_sections: sections.sections,
    wiring,
    routes,
    provider_keys: listProviderKeys(),
    axes,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      summary: provider.summary,
      tier: provider.tier ?? null,
      auth: provider.auth,
      models: provider.models,
      default_model: provider.default_model,
    })),
    defaults: { primary: DEFAULT_ROUTE_PROVIDER, alternate: ALTERNATE_ROUTE_PROVIDER },
    login: loginOptions(),
  });
}

/** Only what a route is: never a key (routes hold none, but redaction applies anyway). */
function routeView(route: { provider_id: string; model: string; params: unknown; fallbacks: unknown }) {
  return { provider_id: route.provider_id, model: route.model, params: route.params, fallbacks: route.fallbacks };
}

/**
 * Records a configuration change (KAN-89) right after it is saved. A failed
 * write throws, so the request reports an error rather than an unrecorded change.
 */
async function audit(
  action: string,
  entity_type: string,
  entity_id: string | null,
  before: unknown,
  after: unknown,
  rationale?: string | null,
  meta?: Record<string, unknown>,
) {
  // Platform-wide settings: no workspace. (save_axes is recorded by saveAxes, in its workspace.)
  await recordAudit({ category: "config", action, entity_type, entity_id, before, after, rationale, meta, workspace_id: null });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return apiErrorResponse(error);
  }
  const action = String(body.action ?? "");
  // The owner holds every platform capability; nobody else reaches these actions.
  if (OWNER_ACTIONS.has(action) && !(await ownerAccess()).owner) return ownerOnlyJson();
  const origin = new URL(request.url).origin;

  try {
    const identity = await requestIdentity(body);
    switch (action) {
      case "set_ai_enabled": {
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false");
        const was = await aiSwitch();
        const ai = await setAiEnabled({
          enabled: body.enabled,
          actor_name: identity.actor.name,
          rationale: typeof body.rationale === "string" ? body.rationale : undefined,
        });
        await audit("set_ai_enabled", "ai_switch", "ai", { enabled: was.enabled }, { enabled: ai.enabled }, ai.rationale);
        return NextResponse.json({ ok: true, ai });
      }
      // One AI section on or off for every customer (KAN-53).
      case "set_ai_section": {
        if (!isAiSectionId(body.section)) throw new Error("Unknown AI section.");
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false");
        const was = (await storedAiSections()).sections;
        const sections = await setAiSection({ section: body.section, enabled: body.enabled, actor_name: identity.actor.name });
        await audit("set_ai_section", "ai_section", body.section, { enabled: was[body.section] }, { enabled: sections[body.section] });
        return NextResponse.json({ ok: true, ai_sections: sections });
      }
      // Every section at once (a fresh platform, or the e2e suite).
      case "set_ai_sections": {
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false");
        const was = (await storedAiSections()).sections;
        let sections = was;
        for (const section of AI_SECTION_IDS) {
          sections = await setAiSection({ section, enabled: body.enabled, actor_name: identity.actor.name });
        }
        await audit("set_ai_sections", "ai_section", "all", was, sections);
        return NextResponse.json({ ok: true, ai_sections: sections });
      }
      case "set_route": {
        const stage = String(body.stage ?? "") as StageId;
        if (!STAGE_IDS.includes(stage)) throw new Error(`Unknown stage ${body.stage}`);
        const provider_id = String(body.provider_id ?? "");
        const was = await routeConfig(stage);
        // Blank numbers keep the current value; blank fallbacks mean none (KAN-63).
        const config = await setRouteConfig({
          stage,
          provider_id,
          model: String(body.model ?? ""),
          temperature: parseRouteParam(body.temperature, "temperature"),
          max_tokens: parseRouteParam(body.max_tokens, "max_tokens"),
          fallbacks: parseFallbacks(body.fallbacks, provider_id),
          actor_name: identity.actor.name,
        });
        await audit("set_route", "route", stage, routeView(was), routeView(config));
        return NextResponse.json({ ok: true, config });
      }
      case "set_default_provider": {
        const was = await routeConfigs();
        const configs = await setDefaultProvider({
          provider_id: String(body.provider_id ?? ""),
          model: body.model ? String(body.model) : undefined,
          actor_name: identity.actor.name,
        });
        await audit(
          "set_default_provider",
          "route",
          "all",
          Object.fromEntries(was.map((route) => [route.stage, routeView(route)])),
          Object.fromEntries(configs.map((route) => [route.stage, routeView(route)])),
        );
        return NextResponse.json({ ok: true, stages: configs.length });
      }
      // Works out the de-identified lessons still pending (AI was off or no route at the time; KAN-78).
      case "compute_lessons": {
        const limit = typeof body.limit === "number" ? body.limit : 50;
        const tally = await computePendingLessons(limit);
        await audit("compute_lessons", "decision_examples", null, null, null, null, { limit, ...tally });
        return NextResponse.json({ ok: true, lessons: tally });
      }
      case "activate_module": {
        const stage = String(body.stage ?? "") as StageId;
        const wiredModule = async () => (await stageWiring()).find((row) => row.stage === stage)?.active ?? null;
        const was = await wiredModule();
        await activateModule({
          stage,
          module_id: String(body.module_id ?? ""),
          actor_name: identity.actor.name,
        });
        const now = await wiredModule();
        await audit(
          "activate_module",
          "stage_module",
          stage,
          was ? { module_id: was.id, version: was.version } : null,
          now ? { module_id: now.id, version: now.version } : null,
        );
        return NextResponse.json({ ok: true });
      }
      case "save_axes": {
        // Customer data: a verified session, a selected workspace the person is a
        // member of, and the prioritize capability. Never the Default workspace by fallback.
        const customer = await requireCustomerContext({ body, capability: "prioritize" });
        const axes = await saveAxes({
          config: body.config,
          actor_name: customer.actor.name,
        });
        return NextResponse.json({ ok: true, axes });
      }
      case "sign_in_demo": {
        const session = await signInDemo({
          actor_name: String(body.actor_name ?? "").trim(),
          actor_function: body.actor_function as never,
          role: body.role as never,
        });
        return NextResponse.json({ ok: true, role: session.role, actor: session.actor });
      }
      case "sign_in_oauth": {
        const provider_id = String(body.provider_id ?? "");
        const { authorize_url } = await beginLogin({
          provider_id,
          redirect_uri: `${origin}/api/auth/callback`,
        });
        return NextResponse.json({ ok: true, authorize_url });
      }
      case "sign_out": {
        await signOut();
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
    }
  } catch (error) {
    return apiErrorResponse(error, "Control-panel action failed");
  }
}
