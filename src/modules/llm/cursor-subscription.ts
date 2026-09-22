import type { LlmRequest } from "./provider";
import { NoRouteError } from "./provider";

/** Sentinel stored when Grok is reached via deployment Cursor subscription, not xAI OAuth. */
export const CURSOR_SUBSCRIPTION_TOKEN = "cursor-subscription";

const CURSOR_API = "https://api.cursor.com";

export function cursorSubscriptionConfigured(): boolean {
  return Boolean(process.env.CURSOR_API_KEY?.trim());
}

function cursorAuthHeader(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) throw new NoRouteError("CURSOR_API_KEY is not set");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

/** Maps Synapse / xAI model ids to Cursor catalog ids when they differ. */
export function cursorModelId(model: string): string {
  const map: Record<string, string> = {
    "grok-4": "grok-4.7",
    "grok-4-fast": "grok-4.7",
    "grok-3": "grok-4.7",
  };
  const override = process.env.CURSOR_GROK_MODEL?.trim();
  if (override) return override;
  return map[model] ?? model;
}

type AgentCreate = { id?: string; run_id?: string };
type RunPoll = { status?: string; result?: string };

/**
 * Grok through a Cursor plan (Cloud Agents API). This is a deployment credential
 * (`CURSOR_API_KEY` from cursor.com/dashboard), not an end-user API key field.
 */
export async function completeViaCursorSubscription(
  request: LlmRequest,
  model: string,
): Promise<string> {
  const modelId = cursorModelId(model);
  const promptText = [
    request.system.trim(),
    "",
    "---",
    "",
    request.user.trim(),
    "",
    "Respond with the assistant message only. If you were asked for JSON, return valid JSON with no markdown fence.",
  ].join("\n");

  const createRes = await fetch(`${CURSOR_API}/v1/agents`, {
    method: "POST",
    headers: {
      authorization: cursorAuthHeader(),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      prompt: { text: promptText },
      model: { id: modelId },
    }),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`Cursor agents HTTP ${createRes.status}: ${createText.slice(0, 400)}`);
  }
  const created = JSON.parse(createText) as AgentCreate;
  const agentId = created.id;
  const runId = created.run_id;
  if (!agentId || !runId) {
    throw new Error("Cursor agents response missing id or run_id");
  }

  const deadline = Date.now() + Number(process.env.CURSOR_AGENT_TIMEOUT_MS ?? 120_000);
  while (Date.now() < deadline) {
    const pollRes = await fetch(`${CURSOR_API}/v1/agents/${agentId}/runs/${runId}`, {
      headers: { authorization: cursorAuthHeader(), accept: "application/json" },
    });
    const pollText = await pollRes.text();
    if (!pollRes.ok) {
      throw new Error(`Cursor run poll HTTP ${pollRes.status}: ${pollText.slice(0, 300)}`);
    }
    const poll = JSON.parse(pollText) as RunPoll;
    const status = (poll.status ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "finished") {
      const result = (poll.result ?? "").trim();
      if (!result) throw new Error("Cursor run completed with no result text");
      return result;
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Cursor run ${status}: ${pollText.slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Cursor agent run timed out");
}
