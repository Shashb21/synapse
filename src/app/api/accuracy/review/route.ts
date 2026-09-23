import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { CompletenessAuditOutput } from "@/accuracy/modules/completeness-audit/module";
import { missFlagSuggestedSchema } from "@/accuracy/modules/completeness-audit/engine";
import { insertClaim } from "@/accuracy/store/claim-store";
import { recordMissFlagAction } from "@/accuracy/store/miss-flag-store";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { listSourceFiles } from "@/accuracy/store/source-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/**
 * GET /api/accuracy/review?workspace_id=…
 * Runs completeness_audit and returns open miss flags (+ source filenames).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspace_id = url.searchParams.get("workspace_id")?.trim() ?? "";
    if (!workspace_id) {
      return NextResponse.json({ ok: false, error: "workspace_id is required" }, { status: 400 });
    }
    const org_id = await getWorkspaceOrgId(workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

    const result = await runAccuracyModule<CompletenessAuditOutput>({
      call_kind: "completeness_audit",
      agent_role: "none",
      input: { workspace_id },
      actor: { name: "Accuracy reviewer", function: "medical_affairs" },
      org_id,
      workspace_id,
    });

    const sources = await listSourceFiles(workspace_id);
    const filenameById = new Map(sources.map((s) => [s.id, s.filename]));

    return NextResponse.json({
      ok: true,
      workspace_id,
      run_id: result.run_id,
      summary: result.summary,
      scanned_blocks: result.output.scanned_blocks,
      open_flags: result.output.open_flags,
      skipped_noise: result.output.skipped_noise,
      skipped_by_reason: result.output.skipped_by_reason,
      flags: result.output.flags.map((flag) => ({
        ...flag,
        source_filename: filenameById.get(flag.source_file_id) ?? flag.source_file_id,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review load failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

const postSchema = z.object({
  workspace_id: z.string().min(1),
  block_id: z.string().min(1),
  action: z.enum(["promote", "dismiss"]),
  suggested: missFlagSuggestedSchema.optional(),
  rationale: z.string().min(1),
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
});

/**
 * POST /api/accuracy/review — promote a miss flag to a draft claim, or dismiss with rationale.
 */
export async function POST(req: Request) {
  try {
    const body = postSchema.parse(await req.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

    const blocks = await readParseBlocksByIds(body.workspace_id, [body.block_id]);
    const block = blocks[0];
    if (!block) {
      return NextResponse.json({ ok: false, error: "Unknown block_id" }, { status: 400 });
    }

    const actor = {
      name: body.actor_name?.trim() || "Accuracy reviewer",
      function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
    };

    const suggested = body.suggested ?? "gap";
    let claim_id: string | null = null;

    if (body.action === "promote") {
      const excerpt = block.text.replace(/\s+/g, " ").trim().slice(0, 500);
      const claim = await insertClaim({
        workspace_id: body.workspace_id,
        claim_type: suggested,
        statement: excerpt,
        status: "draft",
        validated: false,
        source_file_id: block.source_file_id,
        metadata: {
          origin: "completeness_audit",
          source_badge: "miss_flag",
          provenance: [
            {
              source_file_id: block.source_file_id,
              block_id: block.id,
              quote: excerpt.slice(0, 280),
            },
          ],
          miss_flag_rationale: body.rationale.trim(),
        },
      });
      claim_id = claim.id;
    }

    const recorded = await recordMissFlagAction({
      workspace_id: body.workspace_id,
      block_id: body.block_id,
      action: body.action,
      suggested,
      claim_id,
      rationale: body.rationale,
      actor,
    });

    return NextResponse.json({
      ok: true,
      action: body.action,
      block_id: body.block_id,
      claim_id,
      recorded_id: recorded.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review action failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
