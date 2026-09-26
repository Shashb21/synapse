import { NextResponse } from "next/server";
import { AI_OFF_MESSAGE, AiDisabledError } from "@/modules/kernel/ai-switch";
import { apiErrorResponse } from "@/modules/auth/api-guard";

/** A clear 409 for work refused because an admin switched AI off. */
export function aiOffResponse(): NextResponse {
  return NextResponse.json({ code: "ai_off", error: AI_OFF_MESSAGE }, { status: 409 });
}

/**
 * Maps AiDisabledError to 409 ai_off; guard and role failures keep their
 * status (401/403/409); anything else stays a 400 with its message.
 */
export function stageErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof AiDisabledError) return aiOffResponse();
  return apiErrorResponse(error, fallback);
}
