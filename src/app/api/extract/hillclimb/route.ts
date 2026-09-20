import { NextResponse } from "next/server";
import type { ActorFunction } from "@/lib/iegp/enums";
import { runGapPromptHillclimb } from "@/lib/iegp/extract/hillclimb";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, string>;
  const actor_name = body.actor_name?.trim();
  const actor_function = body.actor_function as ActorFunction;
  if (!actor_name || !actor_function) {
    return NextResponse.json({ error: "Name and function are required." }, { status: 400 });
  }
  try {
    const result = await runGapPromptHillclimb({
      actor_name,
      actor_function,
      trigger: body.trigger || "manual",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hill-climb failed";
    const status = /ANTHROPIC_API_KEY/i.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
