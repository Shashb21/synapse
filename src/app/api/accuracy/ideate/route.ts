import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  gapsEligibleForIdeation,
  type PriorityBand,
} from "@/accuracy/domain/iegp-semantics";
import type { IdeateOutput } from "@/accuracy/modules/ideate/schema";
import { claimMetadata, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  gap_id: z.string().min(1),
  /** Required for mechanical stub; optional LLM hint when a route is connected. */
  title: z.string().max(280).optional(),
  rationale: z.string().max(2000).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
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
 * Ideate a net-new proposed tactic for one validated high-priority open gap.
 * Live LLM when OAuth/api_key route is connected; otherwise mechanical stub
 * (requires title + rationale).
 */
export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

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

    const tactics = await listClaims(body.workspace_id, { claim_type: "tactic", limit: 500 });
    const existing_tactic_names = tactics.map((t) => t.statement).filter(Boolean);

    const actor = {
      name: body.actor_name?.trim() || "Ideate",
      function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
    };

    const result = await runAccuracyModule<IdeateOutput>({
      call_kind: "ideate",
      agent_role: "proposer",
      input: {
        workspace_id: body.workspace_id,
        gaps: [
          {
            id: gap.id,
            statement: gap.statement,
            status: resolveGapStatus(gap.status),
            priority_band,
          },
        ],
        existing_tactic_names,
        focus_gap_id: gap.id,
        mechanical: {
          title: body.title?.trim() || undefined,
          rationale: body.rationale?.trim() || undefined,
        },
      },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });

    const proposal =
      result.output.proposals.find((p) => p.gap_id === gap.id) ?? result.output.proposals[0];
    if (!proposal) {
      const titleLen = body.title?.trim().length ?? 0;
      const rationaleLen = body.rationale?.trim().length ?? 0;
      const needsMechanical =
        result.output.mode === "stub" && (titleLen < 8 || rationaleLen < 3);
      return NextResponse.json(
        {
          ok: false,
          error: needsMechanical
            ? "No LLM route connected — provide title (min 8) and rationale (min 3) for the mechanical stub."
            : "Ideation produced no proposal for this gap.",
          mode: result.output.mode,
          stub: result.output.mode === "stub",
        },
        { status: 400 },
      );
    }

    const external = typeof meta.external_id === "string" ? meta.external_id : gap.id;
    const tactic = await insertClaim({
      workspace_id: body.workspace_id,
      claim_type: "tactic",
      statement: proposal.name,
      status: "proposed",
      validated: false,
      source_file_id: gap.source_file_id,
      metadata: {
        origin: "ideated",
        source_badge: "ideate",
        gap_ids: [external],
        ideation_rationale: proposal.rationale,
        design_summary: proposal.design_summary,
        tactic_type: proposal.type,
        ideation_mode: result.output.mode,
        start: body.start ?? null,
        end: body.end ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      tactic_id: tactic.id,
      mode: result.output.mode,
      stub: result.output.mode === "stub",
      run_id: result.run_id,
      proposal: {
        name: proposal.name,
        type: proposal.type,
        rationale: proposal.rationale,
        design_summary: proposal.design_summary,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ideate failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
