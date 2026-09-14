import { PROMPT_REGISTRY } from "@/lib/extract/prompts";
import { getState } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const state = await getState();
  return NextResponse.json({
    champion: state.champion_prompt_version,
    prompts: PROMPT_REGISTRY.map((p) => ({
      version: p.version,
      strategy: p.strategy,
      title: p.title,
      summary: p.summary,
      system_prompt: p.system_prompt,
    })),
  });
}
