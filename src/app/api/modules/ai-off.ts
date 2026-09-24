import { NextResponse } from "next/server";
import { AI_OFF_MESSAGE, AiDisabledError } from "@/modules/kernel/ai-switch";

/** A clear 409 for work refused because an admin switched AI off. */
export function aiOffResponse(): NextResponse {
  return NextResponse.json({ code: "ai_off", error: AI_OFF_MESSAGE }, { status: 409 });
}

/** Maps AiDisabledError to 409 ai_off; anything else stays a 400 with its message. */
export function stageErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof AiDisabledError) return aiOffResponse();
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: message }, { status: 400 });
}
