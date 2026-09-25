import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  gapsEligibleForIdeation,
  resolveGapStatus,
  resolvePriorityBand,
  type PriorityBand,
} from "@/accuracy/domain/iegp-semantics";
import type { IdeateOutput } from "@/accuracy/modules/ideate/module";
import {
  claimMetadata,
  insertClaim,
  listClaims,
  type AccuracyClaimRow,
} from "@/accuracy/store/claim-store";
import { normalizeClaimDate, withHumanEdit } from "@/accuracy/store/claim-edit";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { TACTIC_TYPES } from "@/lib/iegp/enums";
import type { Actor } from "@/accuracy/kernel/contracts";
import { isTestStub } from "@/modules/kernel/llm";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string(),
  gap_id: z.string().optional(),
  title: z.string().min(8).max(280).optional(),
  rationale: z.string().min(3).optional(),
  hints: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  type: z.enum(TACTIC_TYPES).optional(),
  per_gap: z.number().int().min(1).max(3).optional(),
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
});

function gapRecordFromClaim(gap: AccuracyClaimRow) {
  const meta = claimMetadata(gap);
  return {
    id: gap.id,
    statement: gap.statement,
    priority_band: resolvePriorityBand(meta.priority ?? meta.priority_band),
    status: resolveGapStatus(gap.status),
    validated: gap.validated,
  };
}

function requireEligibleGap(gap: AccuracyClaimRow) {
  if (!gap.validated) {
    return { error: "Gap must be validated before ideation.", status: 400 as const };
  }
  const eligible = gapsEligibleForIdeation([gapRecordFromClaim(gap)]);
  if (eligible.length === 0) {
    return {
      error: "Ideation is limited to high-priority open gaps (product lock).",
      status: 400 as const,
    };
  }
  return null;
}

async function persistProposal(args: {
  workspace_id: string;
  gap: AccuracyClaimRow;
  name: string;
  design_summary: string;
  type?: string;
  start?: string | null;
  end?: string | null;
  source_file_id?: string | null;
  /** Manual (human-authored) proposal: fields are human-locked + audited. */
  human?: { rationale: string; actor: Actor };
}) {
  const meta = claimMetadata(args.gap);
  const external = typeof meta.external_id === "string" ? meta.external_id : args.gap.id;
  const start = normalizeClaimDate("start", args.start);
  const end = normalizeClaimDate("end", args.end);
  if (start && end && end < start) {
    throw new Error("End date must be on or after the start date.");
  }
  const base = {
    origin: "ideated",
    source_badge: "ideate",
    gap_ids: [external],
    type: args.type ?? null,
    tactic_type: args.type ?? null,
    design_summary: args.design_summary.trim(),
    ideation_rationale: args.design_summary.trim(),
    not_from_reference: true,
    start,
    end,
  };
  const fields = ["statement", "design_summary", ...(args.type ? ["type"] : []),
    ...(start ? ["start"] : []), ...(end ? ["end"] : [])];
  const metadata = args.human
    ? withHumanEdit(base, {
        action: "create",
        fields,
        before: {},
        after: { statement: args.name.trim(), design_summary: base.design_summary, type: base.type, start, end },
        rationale: args.human.rationale,
        actor: args.human.actor,
      })
    : base;
  return insertClaim({
    workspace_id: args.workspace_id,
    claim_type: "tactic",
    statement: args.name.trim(),
    status: "proposed",
    validated: false,
    source_file_id: args.source_file_id ?? null,
    metadata,
  });
}

/**
 * Ideate proposed tactics for validated high-priority open gaps.
 * - Manual: title + rationale inserts one human-authored proposed tactic (no LLM).
 * - Live: runs the ideate module (OAuth / API key). Stub LLM returns empty proposals.
 *   With the admin AI switch off the live path answers 409 { code: "ai_off" }.
 */
export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await req.json());
    const gaps = await listClaims(body.workspace_id, { claim_type: "gap", limit: 300 });
    const tactics = await listClaims(body.workspace_id, { claim_type: "tactic", limit: 500 });
    const isManual = Boolean(body.title?.trim() && body.rationale?.trim());

    if (isManual) {
      if (!body.gap_id) {
        return NextResponse.json(
          { ok: false, error: "gap_id is required for a manual proposed tactic." },
          { status: 400 },
        );
      }
      const gap = gaps.find((g) => g.id === body.gap_id);
      if (!gap) {
        return NextResponse.json({ ok: false, error: "Gap not found" }, { status: 404 });
      }
      const blocked = requireEligibleGap(gap);
      if (blocked) {
        return NextResponse.json({ ok: false, error: blocked.error }, { status: blocked.status });
      }
      const tactic = await persistProposal({
        workspace_id: body.workspace_id,
        gap,
        name: body.title!.trim(),
        design_summary: body.rationale!.trim(),
        start: body.start ?? null,
        end: body.end ?? null,
        type: body.type,
        source_file_id: gap.source_file_id,
        human: {
          rationale: body.rationale!.trim(),
          actor: {
            name: body.actor_name?.trim() || "Accuracy planner",
            function: (body.actor_function?.trim() || "medical_affairs") as Actor["function"],
          },
        },
      });
      return NextResponse.json({
        ok: true,
        mode: "manual",
        stub: isTestStub(),
        tactic_id: tactic.id,
        tactic_ids: [tactic.id],
        tactics_inserted: 1,
      });
    }

    // LLM ideation from here on: nothing runs or is written with AI off.
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;

    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

    let targetGaps = gaps;
    if (body.gap_id) {
      const gap = gaps.find((g) => g.id === body.gap_id);
      if (!gap) {
        return NextResponse.json({ ok: false, error: "Gap not found" }, { status: 404 });
      }
      const blocked = requireEligibleGap(gap);
      if (blocked) {
        return NextResponse.json({ ok: false, error: blocked.error }, { status: blocked.status });
      }
      targetGaps = [gap];
    }

    const mapped = targetGaps.map(gapRecordFromClaim);
    const eligible = gapsEligibleForIdeation(mapped);
    if (eligible.length === 0) {
      return NextResponse.json({
        ok: true,
        mode: "stub",
        stub: true,
        eligible_gap_ids: [],
        tactic_ids: [],
        tactics_inserted: 0,
        summary: "No high-priority open gaps to ideate for",
      });
    }

    const actor = {
      name: body.actor_name?.trim() || "Accuracy ideate",
      function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
    };

    const result = await runAccuracyModule<IdeateOutput>({
      call_kind: "ideate",
      agent_role: "proposer",
      input: {
        workspace_id: body.workspace_id,
        gaps: mapped.map((g) => ({
          id: g.id,
          statement: g.statement,
          status: g.status,
          priority_band: g.priority_band as PriorityBand | null,
          validated: g.validated,
        })),
        existing_tactic_names: tactics.map((t) => t.statement),
        hints: body.hints?.trim() || undefined,
        per_gap: body.per_gap ?? 1,
      },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });

    const byId = new Map(gaps.map((g) => [g.id, g]));
    const tactic_ids: string[] = [];
    for (const proposal of result.output.proposals) {
      const gap = byId.get(proposal.gap_id);
      if (!gap) continue;
      const inserted = await persistProposal({
        workspace_id: body.workspace_id,
        gap,
        name: proposal.name,
        design_summary: proposal.design_summary,
        type: proposal.type,
      });
      tactic_ids.push(inserted.id);
    }

    const stub = result.output.mode === "stub" || isTestStub();
    return NextResponse.json({
      ok: true,
      mode: result.output.mode,
      stub,
      run_id: result.run_id,
      eligible_gap_ids: result.output.eligible_gap_ids,
      tactic_ids,
      tactics_inserted: tactic_ids.length,
      summary: result.summary,
    });
  } catch (error) {
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    const message = error instanceof Error ? error.message : "Ideate failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
