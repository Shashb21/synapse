import { NextResponse } from "next/server";
import { AI_OFF_MESSAGE, AiDisabledError, aiEnabled } from "@/modules/kernel/ai-switch";

/**
 * Shared AI-off answer for accuracy API routes. With the admin AI switch off,
 * every AI step answers 409 `{ code: "ai_off" }` before anything is written —
 * never a generic 400/500 — so the UI can point at the manual path instead.
 */
export function aiOffResponse(): NextResponse {
  return NextResponse.json({ ok: false, code: "ai_off", error: AI_OFF_MESSAGE }, { status: 409 });
}

/** The 409 response when AI is off, or null when AI steps may run. */
export async function refuseWhenAiOff(): Promise<NextResponse | null> {
  return (await aiEnabled()) ? null : aiOffResponse();
}

/** Maps an AiDisabledError thrown mid-request (switch flipped) to the 409. */
export function aiOffFromError(error: unknown): NextResponse | null {
  return error instanceof AiDisabledError ? aiOffResponse() : null;
}
