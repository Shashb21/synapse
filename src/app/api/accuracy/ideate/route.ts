import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import {
  gapsEligibleForIdeation,
  type PriorityBand,
} from "@/accuracy/domain/iegp-semantics";
import { claimMetadata, insertClaim, listClaims } from "@/accuracy/store/claim-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string(),
  gap_id: z.string(),
  title: z.string().min(8).max(280),
  rationale: z.string().min(3),
  start: z.string().optional(),
  end: z.string().optional(),
});

function resolvePriorityBand(raw: unknown): PriorityBand | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  // Product lock: ideation only for high. Treat "critical" as high-band.
  if (value === "high" || value === "critical") return "high";
  if (value === "medium") return "medium";
  if (value === "low") return "low";
  return null;
}

function resolveGapStatus(status: string): "open" | "partial" | "addressed" {
  if (status === "partial" || status === "addressed") return status;
  return "open";
}

/**
 * Mechanical ideation stub (no LLM): create a proposed tactic for a high-priority gap only.
 * Live LLM ideation remains behind OAuth routing when credentials exist.
 */
export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    const gaps = await listClaims(body.workspace_id, { claim_type: "gap", limit: 300 });
    const gap = gaps.find((g) => g.id === body.gap_id);
    if (!gap) {
      return NextResponse.json({ ok: false, error: "Gap not found" }, { status: 404 });
    }
    if (!gap.validated) {
      return NextResponse.json(
        { ok: false, error: "Gap must be validated before ideation." },
        { status: 400 },
      );
    }

    const meta = claimMetadata(gap);
    const priority_band = resolvePriorityBand(meta.priority ?? meta.priority_band);
    const eligible = gapsEligibleForIdeation([
      {
        id: gap.id,
        priority_band,
        status: resolveGapStatus(gap.status),
      },
    ]);
    if (eligible.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Ideation is limited to high-priority open gaps (product lock).",
        },
        { status: 400 },
      );
    }

    const external = typeof meta.external_id === "string" ? meta.external_id : gap.id;
    const tactic = await insertClaim({
      workspace_id: body.workspace_id,
      claim_type: "tactic",
      statement: body.title.trim(),
      status: "proposed",
      validated: false,
      source_file_id: gap.source_file_id,
      metadata: {
        origin: "ideated",
        source_badge: "ideate",
        gap_ids: [external],
        ideation_rationale: body.rationale.trim(),
        start: body.start ?? null,
        end: body.end ?? null,
      },
    });

    return NextResponse.json({ ok: true, tactic_id: tactic.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ideate failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
