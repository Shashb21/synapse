import { NextResponse } from "next/server";
import { AI_OFF_MESSAGE, AiDisabledError } from "@/modules/kernel/ai-switch";
import { apiErrorResponse } from "@/modules/auth/api-guard";

/** A clear 409 for work refused because an admin switched AI off. */
export function aiOffResponse(): NextResponse {
  return NextResponse.json({ code: "ai_off", error: AI_OFF_MESSAGE }, { status: 409 });
}

/**
 * Maps AiDisabledError to 409 ai_off; guard and role failures keep their
 * status (401/403/409); NoRouteError becomes 409 no_llm (text chosen by
 * audience, see noLlmResponse); a provider failure is a 502; anything else
 * stays a 400. A failed AI step's message is the owner's technical one for the
 * owner and customer wording for everyone else (stageFailureBody, KAN-68).
 */
export async function stageErrorResponse(error: unknown, fallback: string): Promise<NextResponse> {
  if (error instanceof AiDisabledError) return aiOffResponse();
  return apiErrorResponse(error, fallback);
}
