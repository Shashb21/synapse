import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import type { CompletenessAuditOutput } from "@/accuracy/modules/completeness-audit/module";
import { missFlagSuggestedSchema } from "@/accuracy/modules/completeness-audit/engine";
import { createManualClaim } from "@/accuracy/store/claim-edit";
import { recordMissFlagAction } from "@/accuracy/store/miss-flag-store";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import {
  labActor,
  labRequestErrorResponse,
  parseLabBody,
  requireLabWorkspace,
} from "@/app/api/accuracy/_lib/request";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { sessionContext } from "@/modules/auth/session";
import type { Role } from "@/modules/auth/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

function canReview(role: Role): boolean {
  return role === "medical_affairs" || role === "contributor";
}

function assemblyReviewStatus(error: AssemblyReviewError): number {
  if (error.code === "invalid_input") return 400;
  if (error.code === "not_found") return 404;
  if (error.code === "forbidden") return 403;
  return 409;
}

/**
 * GET /api/accuracy/review?workspace_id=…
 * Runs completeness_audit (LLM completeness critic) and returns open miss flags
 * (+ source filenames). Without a connected LLM it fails; nothing is guessed.
 * With the admin AI switch off the audit never runs: 409 { code: "ai_off" }.
 */
export async function GET(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const session = await sessionContext();
    if (!session.signed_in || !session.session) {
      return NextResponse.json({ ok: false, error: "Sign in to access review." }, { status: 401 });
    }
    const url = new URL(req.url);
    const workspace_id = url.searchParams.get("workspace_id")?.trim() ?? "";
    if (!workspace_id) {
      return NextResponse.json({ ok: false, error: "workspace_id is required" }, { status: 400 });
    }
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    await requireLabWorkspace(workspace_id);
    const workspace = await getAuthorizedWorkspace({ workspace_id, subject: session.session.subject, role: session.role });
    if (!workspace) {
      return NextResponse.json({ ok: false, error: "Workspace not found" }, { status: 404 });
    }

    const result = await runAccuracyModule<CompletenessAuditOutput>({
      call_kind: "completeness_audit",
      agent_role: "critic",
      input: { workspace_id },
      actor: session.actor,
      org_id: workspace.org_id,
      workspace_id,
    });

    const sources = await listSourceFiles(workspace_id);
    const filenameById = new Map(sources.map((s) => [s.id, s.filename]));

    return NextResponse.json({
      ok: true,
      workspace_id,
      run_id: result.run_id,
      summary: result.summary,
      mode: result.output.mode,
      scanned_blocks: result.output.scanned_blocks,
      open_flags: result.output.open_flags,
      cited_blocks: result.output.cited_blocks,
      judged_blocks: result.output.judged_blocks,
      reused_verdicts: result.output.reused_verdicts,
      skipped_noise: result.output.skipped_noise,
      flags: result.output.flags.map((flag) => ({
        ...flag,
        source_filename: filenameById.get(flag.source_file_id) ?? flag.source_file_id,
      })),
    });
  } catch (error) {
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    if (error instanceof AssemblyReviewError) {
      const status = assemblyReviewStatus(error);
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
    }
    console.error("Review load failed", error);
    return NextResponse.json({ ok: false, error: "Review load failed" }, { status: 500 });
  }
}

const postSchema = z.object({
  workspace_id: z.string().min(1),
  block_id: z.string().min(1),
  action: z.enum(["promote", "dismiss"]),
  suggested: missFlagSuggestedSchema.optional(),
  /** Promote only: the reviewer's wording of the claim (defaults to the block excerpt). */
  statement: z.string().max(2000).optional(),
  rationale: z.string().min(1),
}).strict();

/**
 * POST /api/accuracy/review — promote a miss flag to a draft claim, or dismiss with rationale.
 */
export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const session = await sessionContext();
    if (!session.signed_in || !session.session) {
      return NextResponse.json({ ok: false, error: "Sign in to review miss flags." }, { status: 401 });
    }
    if (!canReview(session.role)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    const body = await parseLabBody(req, postSchema);
    if (!await getAuthorizedWorkspace({ workspace_id: body.workspace_id, subject: session.session.subject, role: session.role })) {
      return NextResponse.json({ ok: false, error: "Workspace not found" }, { status: 404 });
    }

    const blocks = await readParseBlocksByIds(body.workspace_id, [body.block_id]);
    const block = blocks[0];
    if (!block) {
      return NextResponse.json({ ok: false, error: "Unknown block_id" }, { status: 400 });
    }

    const actor = await labActor();

    const suggested = body.suggested ?? "gap";
    let claim_id: string | null = null;

    if (body.action === "promote") {
      const excerpt = block.text.replace(/\s+/g, " ").trim().slice(0, 500);
      const statement = body.statement?.trim() || excerpt;
      // Promotion is a human decision: the claim is human-authored (statement locked).
      const claim = await createManualClaim({
        workspace_id: body.workspace_id,
        claim_type: suggested,
        statement,
        rationale: body.rationale,
        actor,
        action: "promote",
        origin: "completeness_audit",
        source_badge: "miss_flag",
        status: "draft",
        source_file_id: block.source_file_id,
        metadata: {
          ...(statement !== excerpt ? { promoted_from_excerpt: excerpt } : {}),
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
      actor: session.actor,
    });

    return NextResponse.json({
      ok: true,
      action: body.action,
      block_id: body.block_id,
      claim_id,
      recorded_id: recorded.id,
    });
  } catch (error) {
    const known = labRequestErrorResponse(error);
    if (known) return known;
    if (error instanceof SyntaxError) return NextResponse.json({ ok: false, error: "Invalid JSON request." }, { status: 400 });
    if (error instanceof z.ZodError) return NextResponse.json({ ok: false, error: error.issues.map(issue => issue.message).join("; ") }, { status: 400 });
    if (error instanceof AssemblyReviewError) {
      const status = assemblyReviewStatus(error);
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
    }
    console.error("Review action failed", error);
    return NextResponse.json({ ok: false, error: "Review action failed" }, { status: 500 });
  }
}
