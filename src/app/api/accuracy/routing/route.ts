import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import {
  accuracyRouteConfigs,
  registerAccuracyStack,
  setAccuracyRouteConfig,
  setAccuracyDefaultProvider,
  type CallKind,
} from "@/accuracy";
import { CALL_KINDS, AGENT_ROLES, type AgentRole } from "@/accuracy/kernel/contracts";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  PROVIDERS,
} from "@/modules/llm/provider";
import { assertCan } from "@/modules/auth/roles";
import { requestIdentity } from "@/modules/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  const routes = await accuracyRouteConfigs();
  return NextResponse.json({
    routes,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      models: provider.models,
      default_model: provider.default_model,
      auth: provider.auth,
    })),
    defaults: { primary: DEFAULT_ROUTE_PROVIDER, alternate: ALTERNATE_ROUTE_PROVIDER },
  });
}

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = (await request.json()) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const identity = await requestIdentity(body);

  try {
    switch (action) {
      case "set_route": {
        assertCan(identity.role, "configure_routing");
        const call_kind = String(body.call_kind ?? "") as CallKind;
        if (!CALL_KINDS.includes(call_kind)) {
          throw new Error(`Unknown call_kind ${body.call_kind}`);
        }
        const agent_role = String(body.agent_role ?? "proposer") as AgentRole | "none";
        if (agent_role !== "none" && !AGENT_ROLES.includes(agent_role as AgentRole)) {
          throw new Error(`Unknown agent_role ${body.agent_role}`);
        }
        const config = await setAccuracyRouteConfig({
          call_kind,
          agent_role,
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
        assertCan(identity.role, "configure_routing");
        const configs = await setAccuracyDefaultProvider({
          provider_id: String(body.provider_id ?? ""),
          model: body.model ? String(body.model) : undefined,
          actor_name: identity.actor.name,
        });
        return NextResponse.json({ ok: true, routes: configs.length });
      }
      default:
        return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Accuracy routing action failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
