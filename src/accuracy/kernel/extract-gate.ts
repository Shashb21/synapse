import { NoRouteError } from "@/modules/llm/provider";
import { AI_OFF_MESSAGE, aiEnabled } from "@/modules/kernel/ai-switch";
import { accuracyAuthAllowsLive, resolveAccuracyRoute } from "./routing";
import { isTestStub } from "@/modules/kernel/llm";

export const EXTRACT_CONNECT_PATH = "/admin/control";
export const EXTRACT_KEY_GATE_CODE = "api_key_required" as const;

export const EXTRACT_KEY_GATE_MESSAGE =
  "Set XAI_API_KEY (Grok, default) or ANTHROPIC_API_KEY (Claude) in the server environment to run live extract. Key status is in /admin/control.";

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
      auth: "api_key";
      connect_path: typeof EXTRACT_CONNECT_PATH;
    }
  | {
      ready: false;
      stub: false;
      code: typeof EXTRACT_KEY_GATE_CODE;
      message: string;
      reason: string;
      connect_path: typeof EXTRACT_CONNECT_PATH;
    };

function notReady(reason: string): Extract<LiveExtractGate, { ready: false }> {
  return {
    ready: false,
    stub: false,
    code: EXTRACT_KEY_GATE_CODE,
    message: EXTRACT_KEY_GATE_MESSAGE,
    reason,
    connect_path: EXTRACT_CONNECT_PATH,
  };
}

export function isExtractStubLlm(): boolean {
  return isTestStub();
}

/** Whether inventory/need extract can run (stub tests or a route whose API key is set). */
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
      return notReady(route.reason ?? EXTRACT_KEY_GATE_MESSAGE);
    }
    if (route.auth !== "api_key") {
      return notReady(route.reason ?? EXTRACT_KEY_GATE_MESSAGE);
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
        : EXTRACT_KEY_GATE_MESSAGE;
    return notReady(reason);
  }
}

export function extractKeyGateJson(gate: Extract<LiveExtractGate, { ready: false }>) {
  return {
    ok: false as const,
    error: gate.message,
    gate: gate.code,
    connect_path: gate.connect_path,
    reason: gate.reason,
  };
}
