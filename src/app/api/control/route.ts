import { NextResponse } from "next/server";
import "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { activateModule, stageWiring } from "@/modules/kernel/registry";
import { routeConfigs, setDefaultProvider, setRouteConfig } from "@/modules/kernel/routing";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  PROVIDERS,
} from "@/modules/llm/provider";
import { beginOauth, disconnect, listConnections } from "@/modules/llm/oauth";
import { assertCan } from "@/modules/auth/roles";
import { requestIdentity } from "@/modules/auth/request";
import { ownerAccess, ownerGate, ownerOnlyJson } from "@/modules/auth/owner";
import { beginLogin, loginOptions, signInDemo, signOut } from "@/modules/auth/session";
import { loadAxes, saveAxes } from "@/modules/stages/s8-prioritization/axes";
import { aiSwitch, setAiEnabled } from "@/modules/kernel/ai-switch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform actions only the owner may take (the admin console at /admin/control).
 * Sign-in, sign-out and the prioritization axes stay open to customers.
 */
const OWNER_ACTIONS = new Set([
  "set_ai_enabled",
  "set_route",
  "set_default_provider",
  "activate_module",
  "connect_provider",
  "disconnect_provider",
]);

/** Platform configuration (routes, provider connections, module wiring): owner only. */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  const [wiring, routes, connections, axes, ai] = await Promise.all([
    stageWiring(),
    routeConfigs(),
    listConnections(),
    loadAxes(),
    aiSwitch(),
  ]);
  return NextResponse.json({
    ai,
    wiring,
    routes,
    connections,
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

export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const action = String(body.action ?? "");
  // The owner holds every platform capability; nobody else reaches these actions.
  if (OWNER_ACTIONS.has(action) && !(await ownerAccess()).owner) return ownerOnlyJson();
  const identity = await requestIdentity(body);
  const origin = new URL(request.url).origin;

  try {
    switch (action) {
      case "set_ai_enabled": {
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false");
        const ai = await setAiEnabled({
          enabled: body.enabled,
          actor_name: identity.actor.name,
          rationale: typeof body.rationale === "string" ? body.rationale : undefined,
        });
        return NextResponse.json({ ok: true, ai });
      }
      case "set_route": {
        const stage = String(body.stage ?? "") as StageId;
        if (!STAGE_IDS.includes(stage)) throw new Error(`Unknown stage ${body.stage}`);
        const config = await setRouteConfig({
          stage,
          provider_id: String(body.provider_id ?? ""),
          model: String(body.model ?? ""),
          temperature: body.temperature === undefined ? undefined : Number(body.temperature),
          max_tokens: body.max_tokens === undefined ? undefined : Number(body.max_tokens),
          fallbacks:
            typeof body.fallbacks === "string"
              ? body.fallbacks.split(",").map((id) => id.trim()).filter(Boolean)
              : Array.isArray(body.fallbacks)
                ? (body.fallbacks as string[])
                : undefined,
          actor_name: identity.actor.name,
        });
        return NextResponse.json({ ok: true, config });
      }
      case "set_default_provider": {
        const configs = await setDefaultProvider({
          provider_id: String(body.provider_id ?? ""),
          model: body.model ? String(body.model) : undefined,
          actor_name: identity.actor.name,
        });
        return NextResponse.json({ ok: true, stages: configs.length });
      }
      case "activate_module": {
        const stage = String(body.stage ?? "") as StageId;
        await activateModule({
          stage,
          module_id: String(body.module_id ?? ""),
          actor_name: identity.actor.name,
        });
        return NextResponse.json({ ok: true });
      }
      case "connect_provider": {
        const provider_id = String(body.provider_id ?? "");
        const { authorize_url } = await beginOauth({
          provider_id,
          redirect_uri: `${origin}/api/oauth/llm/callback?provider=${encodeURIComponent(provider_id)}`,
          actor_name: identity.actor.name,
        });
        return NextResponse.json({ ok: true, authorize_url });
      }
      case "disconnect_provider": {
        await disconnect(String(body.provider_id ?? ""));
        return NextResponse.json({ ok: true });
      }
      case "save_axes": {
        assertCan(identity.role, "prioritize");
        const axes = await saveAxes({
          config: body.config,
          actor_name: identity.actor.name,
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
    const message = error instanceof Error ? error.message : "Control-panel action failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
