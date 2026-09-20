import { NextResponse } from "next/server";
import { gapExtractLlmReady } from "@/lib/iegp/extract/client";
import { extractSettings, listGoldGaps } from "@/lib/iegp/extract/store";
import { anthropicModel, anthropicWorkspaceId, hasAnthropicKey } from "@/lib/config";
import { agenticAuthStatus, agenticCallSummary } from "@/lib/llm/agentic";

export const runtime = "nodejs";

export async function GET() {
  const settings = await extractSettings();
  const gold = await listGoldGaps();
  const auth = agenticAuthStatus();
  const calls = agenticCallSummary();
  return NextResponse.json({
    llm_ready: gapExtractLlmReady(),
    anthropic: hasAnthropicKey(),
    anthropic_model: auth.ready ? anthropicModel() : null,
    anthropic_workspace: Boolean(anthropicWorkspaceId()),
    auth_mode: auth.auth_mode,
    oauth: auth.oauth,
    oauth_source: auth.oauth ? auth.source : null,
    oauth_expires_at: auth.expires_at,
    reauth_needed: auth.reauth_needed,
    llm_calls: calls,
    champion_version: settings?.champion_version ?? null,
    last_hillclimb_at: settings?.last_hillclimb_at ?? null,
    last_error: settings?.last_error ?? null,
    gold_gap_count: gold.length,
    key_hint: !auth.ready ? auth.hint : null,
  });
}
