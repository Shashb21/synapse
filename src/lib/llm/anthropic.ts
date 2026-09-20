import { anthropicApiKey, anthropicModel, anthropicWorkspaceId } from "@/lib/config";

type AnthropicMessage = {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
};

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Claude did not return a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function completeJson(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<unknown> {
  const apiKey = anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  const workspace = anthropicWorkspaceId();
  if (workspace) headers["anthropic-workspace-id"] = workspace;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: args.maxTokens ?? 8192,
      temperature: 0,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    }),
  });
  const body = (await res.json()) as AnthropicMessage;
  if (!res.ok) {
    const message = body.error?.message ?? `Anthropic HTTP ${res.status}`;
    if (/workspace-id|not scoped to a workspace/i.test(message) && !workspace) {
      throw new Error(
        "ANTHROPIC_WORKSPACE_ID is not set. This Anthropic API key is identity-linked and needs anthropic-workspace-id on every request (Claude Console → Settings → Workspaces, wrkspc_…).",
      );
    }
    throw new Error(message);
  }
  const text = (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return extractJsonObject(text);
}
