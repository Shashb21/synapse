import { NoRouteError } from "@/modules/llm/provider";
import { AI_OFF_MESSAGE, aiEnabled } from "@/modules/kernel/ai-switch";
import { accuracyAuthAllowsLive, resolveAccuracyRoute } from "./routing";
import { isTestStub } from "@/modules/kernel/llm";

export const EXTRACT_CONNECT_PATH = "/control";
export const EXTRACT_OAUTH_GATE_CODE = "oauth_required" as const;

export const EXTRACT_OAUTH_GATE_MESSAGE =
  "Connect Grok (default) or Claude in /control to run live extract. Sign in with OAuth — not an API key.";

export { accuracyAuthAllowsLive, anthropicWorkspaceConfigured } from "./routing";

export type LiveExtractGate =
  | {
      ready: true;
      stub: true;
      connect_path: typeof EXTRACT_CONNECT_PATH;
    }
  | {
      ready: true;
      stub: false;
      provider_id: string;
      provider_label: string;
      auth: "oauth" | "api_key";
      connect_path: typeof EXTRACT_CONNECT_PATH;
    }
  | {
      ready: false;
      stub: false;
      code: typeof EXTRACT_OAUTH_GATE_CODE;
      message: string;
      reason: string;
      connect_path: typeof EXTRACT_CONNECT_PATH;
    };

function notReady(reason: string): Extract<LiveExtractGate, { ready: false }> {
  return {
    ready: false,
    stub: false,
    code: EXTRACT_OAUTH_GATE_CODE,
    message: EXTRACT_OAUTH_GATE_MESSAGE,
    reason,
    connect_path: EXTRACT_CONNECT_PATH,
  };
}

export function isExtractStubLlm(): boolean {
  return isTestStub();
}

/** Whether inventory/need extract can run (stub tests or a connected OAuth/key route). */
export async function inspectLiveExtractGate(): Promise<LiveExtractGate> {
  if (!(await aiEnabled())) return notReady(AI_OFF_MESSAGE);
  if (isExtractStubLlm()) {
    return { ready: true, stub: true, connect_path: EXTRACT_CONNECT_PATH };
  }
  try {
    const route = await resolveAccuracyRoute({
      call_kind: "need_extract",
      agent_role: "proposer",
    });
    if (!route.connected || !accuracyAuthAllowsLive(route.provider_id, route.auth)) {
      return notReady(route.reason ?? EXTRACT_OAUTH_GATE_MESSAGE);
    }
    if (route.auth !== "oauth" && route.auth !== "api_key") {
      return notReady(route.reason ?? EXTRACT_OAUTH_GATE_MESSAGE);
    }
    return {
      ready: true,
      stub: false,
      provider_id: route.provider_id,
      provider_label: route.provider_label,
      auth: route.auth,
      connect_path: EXTRACT_CONNECT_PATH,
    };
  } catch (error) {
    const reason =
      error instanceof NoRouteError || error instanceof Error
        ? error.message
        : EXTRACT_OAUTH_GATE_MESSAGE;
    return notReady(reason);
  }
}

export function extractOauthGateJson(gate: Extract<LiveExtractGate, { ready: false }>) {
  return {
    ok: false as const,
    error: gate.message,
    gate: gate.code,
    connect_path: gate.connect_path,
    reason: gate.reason,
  };
}
