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
import { accuracyRouteConfig } from "@/accuracy/kernel/routing";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  PROVIDERS,
  findProvider,
} from "@/modules/llm/provider";
import { assertCan } from "@/modules/auth/roles";
import { requestIdentity } from "@/modules/auth/request";
import { labErrorMessage, labRequestErrorResponse, readLabJson } from "@/app/api/accuracy/_lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/** Blank (or left out) keeps the route's current value. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** A numeric route parameter in range, or undefined to keep the current one. */
function routeNumber(
  value: unknown,
  label: string,
  range: { min: number; max: number; integer?: boolean },
): number | undefined {
  if (isBlank(value)) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (
    !Number.isFinite(parsed) ||
    (range.integer && !Number.isInteger(parsed)) ||
    parsed < range.min ||
    parsed > range.max
  ) {
    throw new Error(
      `${label} must be ${range.integer ? "a whole number" : "a number"} from ${range.min} to ${range.max}.`,
    );
  }
  return parsed;
}

/** Fallback provider ids (comma list or array), or undefined to keep the current ones. */
function routeFallbacks(value: unknown): string[] | undefined {
  if (isBlank(value)) return undefined;
  const ids =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.map((id) => (typeof id === "string" ? id : ""))
        : null;
  if (!ids) throw new Error("Fallbacks must be a comma-separated list of provider ids.");
  const cleaned = ids.map((id) => id.trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  const unknown = cleaned.filter((id) => !findProvider(id));
  if (unknown.length > 0) throw new Error(`Unknown fallback provider: ${unknown.join(", ")}.`);
  return cleaned;
}

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
  let body: Record<string, unknown>;
  try {
    const parsed = await readLabJson(request);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    return labRequestErrorResponse(error) ?? NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = String(body.action ?? "");

  try {
    const identity = await requestIdentity(body);
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
        // Validated before anything is saved; a blank field keeps the route's current value.
        const temperature = routeNumber(body.temperature, "Temperature", { min: 0, max: 2 });
        const max_tokens = routeNumber(body.max_tokens, "Max tokens", { min: 1, max: 200_000, integer: true });
        const fallbacks = routeFallbacks(body.fallbacks);
        const current = await accuracyRouteConfig(call_kind, agent_role);
        const config = await setAccuracyRouteConfig({
          call_kind,
          agent_role,
          provider_id: String(body.provider_id ?? ""),
          model: String(body.model ?? ""),
          temperature: temperature ?? current.params.temperature,
          max_tokens: max_tokens ?? current.params.max_tokens,
          fallbacks: fallbacks ?? current.fallbacks,
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
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Accuracy routing action failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
