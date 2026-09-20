import { NextResponse } from "next/server";
import { gapExtractLlmReady } from "@/lib/iegp/extract/client";
import { extractSettings, listGoldGaps } from "@/lib/iegp/extract/store";
import { anthropicModel, hasAnthropicKey } from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  const settings = await extractSettings();
  const gold = await listGoldGaps();
  return NextResponse.json({
    llm_ready: gapExtractLlmReady(),
    anthropic: hasAnthropicKey(),
    anthropic_model: hasAnthropicKey() ? anthropicModel() : null,
    champion_version: settings?.champion_version ?? null,
    last_hillclimb_at: settings?.last_hillclimb_at ?? null,
    last_error: settings?.last_error ?? null,
    gold_gap_count: gold.length,
    key_hint: hasAnthropicKey()
      ? null
      : "Set ANTHROPIC_API_KEY on the Cloud environment (or .env.local). Secrets inject at boot; start a new agent after attaching the key.",
  });
}
