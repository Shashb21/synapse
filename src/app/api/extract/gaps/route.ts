import { NextResponse } from "next/server";
import type { ActorFunction, SourceType } from "@/lib/iegp/enums";
import { startGapExtraction } from "@/lib/iegp/extract/orchestrate";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const body = (await request.json()) as Record<string, unknown>;
  const actor_name = String(body.actor_name ?? "").trim();
  const actor_function = body.actor_function as ActorFunction;
  if (!actor_name || !actor_function) {
    return NextResponse.json({ error: "Name and function are required." }, { status: 400 });
  }
  const waitParam = url.searchParams.get("wait");
  const wait =
    waitParam === "1" ||
    waitParam === "true" ||
    body.wait === true ||
    body.wait === "1";
  try {
    const result = await startGapExtraction({
      format: body.format === "json" ? "json" : body.format === "markdown" ? "markdown" : undefined,
      markdown: typeof body.markdown === "string" ? body.markdown : typeof body.text === "string" ? body.text : undefined,
      json: body.json ?? body.document,
      title: typeof body.title === "string" ? body.title : undefined,
      filename: typeof body.filename === "string" ? body.filename : undefined,
      source_type: body.source_type as SourceType | undefined,
      stakeholder_function: (body.stakeholder_function as ActorFunction | undefined) ?? actor_function,
      persist: Boolean(body.persist),
      wait,
      score_vs_gold: Boolean(body.score_vs_gold),
      source_key: typeof body.source_key === "string" ? body.source_key : undefined,
      actor_name,
      actor_function,
      prompt_version: typeof body.prompt_version === "string" ? body.prompt_version : undefined,
    });
    if (!wait) {
      return NextResponse.json({ ok: true, run_id: result.run_id, status: result.status }, { status: 202 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gap extraction failed";
    const status = /ANTHROPIC_API_KEY/i.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
