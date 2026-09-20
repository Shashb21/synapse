import { NextResponse } from "next/server";
import type { AgenticPurpose } from "@/lib/llm/agentic";
import { isLlmModuleId, isLlmProviderId, moduleForPurpose } from "@/lib/llm/catalog";
import { completeJson, resolveRoute } from "@/lib/llm/router";
import { loadLlmSettings } from "@/lib/llm/settings";

export const runtime = "nodejs";

type ChatMessage = { role?: string; content?: string };

function fromMessages(messages: ChatMessage[] | undefined, system?: string, user?: string) {
  const fromSystem = (messages ?? [])
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n\n");
  const fromUser = [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "user" && typeof m.content === "string")?.content;
  return {
    system: (system?.trim() || fromSystem).trim(),
    user: (user?.trim() || fromUser || "").trim(),
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const purpose = typeof body.purpose === "string" ? (body.purpose as AgenticPurpose) : undefined;
  const moduleId = isLlmModuleId(body.module) ? body.module : moduleForPurpose(purpose);
  const provider = isLlmProviderId(body.provider) ? body.provider : undefined;
  const model = typeof body.model === "string" ? body.model.trim() : undefined;
  const { system, user } = fromMessages(
    Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : undefined,
    typeof body.system === "string" ? body.system : undefined,
    typeof body.user === "string" ? body.user : undefined,
  );
  const cfg = await loadLlmSettings();
  const resolved = resolveRoute(
    { system, user, purpose, module: moduleId, provider, model },
    cfg,
  );
  if (body.wait === false) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      module: resolved.module,
      purpose: resolved.purpose,
      route: resolved.route,
    });
  }
  if (!system || !user) {
    return NextResponse.json(
      { error: "Provide system + user, or messages with those roles." },
      { status: 400 },
    );
  }
  try {
    const json = await completeJson({
      system,
      user,
      maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
      purpose: resolved.purpose,
      module: resolved.module,
      model: resolved.route.model,
      provider,
    });
    return NextResponse.json({
      ok: true,
      json,
      module: resolved.module,
      purpose: resolved.purpose,
      route: resolved.route,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM complete failed";
    return NextResponse.json(
      {
        error: message,
        module: resolved.module,
        purpose: resolved.purpose,
        route: resolved.route,
      },
      { status: 400 },
    );
  }
}
