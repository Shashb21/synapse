import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  extractKeyGateJson,
  inspectLiveExtractGate,
} from "@/accuracy/kernel/extract-gate";
import type { NeedExtractOutput } from "@/accuracy/modules/need-extract/module";
import type { InventoryExtractOutput } from "@/accuracy/modules/inventory-extract/module";
import type { MergeDedupeOutput } from "@/accuracy/modules/merge-dedupe/module";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
import {
  completedExtractKinds, extractContinuationSchema, extractPageProgress,
  ExtractContinuationError, prepareExtractPage, retryExtractContinuation, saveExtractBatch,
  type ExtractPage,
} from "@/accuracy/store/extract-batch-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { siThemeFromGapId } from "@/accuracy/domain/ledger-filters";
import { NoRouteError } from "@/modules/llm/provider";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import {
  labActor,
  labErrorMessage,
  labRequestErrorResponse,
  parseLabBody,
  requireLabWorkspace,
} from "@/app/api/accuracy/_lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  source_file_id: z.string().min(1),
  kinds: z
    .array(z.enum(["need", "inventory"]))
    .min(1)
    .default(["need", "inventory"]),
  continuation: extractContinuationSchema.optional(),
  /** Ignored: the run is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
});

/**
 * Run need_extract and/or inventory_extract for a source file's parse blocks,
 * persist resulting claims, then merge/dedupe and derive Open/Partial/Addressed.
 */
export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  let page: ExtractPage | undefined;
  try {
    const body = await parseLabBody(req, bodySchema);
    // Extract is an AI step: with AI off, refuse before reading or writing anything.
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    const { org_id } = await requireLabWorkspace(body.workspace_id);

    const sources = await listSourceFiles(body.workspace_id);
    const source = sources.find((row) => row.id === body.source_file_id);
    if (!source) {
      return NextResponse.json({ ok: false, safe_error: true, error: "Unknown source_file_id" }, { status: 404 });
    }

    page = await prepareExtractPage({
      workspace_id: body.workspace_id,
      source_file_id: body.source_file_id,
      reference_pack_id: source.reference_pack_id ?? null,
      kinds: body.kinds,
      continuation: body.continuation,
    });
    if (page.total === 0) {
      return NextResponse.json({ ok: false, safe_error: true, error: "No parse blocks for this source — upload/re-parse before extracting." }, { status: 400 });
    }
    const block_ids = page.blocks.map((block) => block.id);

    const gate = await inspectLiveExtractGate();
    if (!gate.ready) {
      return NextResponse.json(extractKeyGateJson(gate), { status: 409 });
    }

    const actor = await labActor();

    const kinds = body.kinds;
    const completed = await completedExtractKinds(page);
    let gaps_inserted = 0;
    let tactics_inserted = 0;
    const runs: Array<{
      call_kind: string;
      run_id: string;
      summary: string;
      count: number;
    }> = [];

    if (kinds.includes("need") && !completed.has("need")) {
      const result = await runAccuracyModule<NeedExtractOutput>({
        call_kind: "need_extract",
        agent_role: "proposer",
        input: {
          workspace_id: body.workspace_id,
          source_file_id: body.source_file_id,
          block_ids,
        },
        actor,
        org_id,
        workspace_id: body.workspace_id,
      });
      if (result.output.workspace_id !== body.workspace_id || result.output.source_file_id !== body.source_file_id) {
        throw new TrustedApplicationError("Extraction returned a different workspace or source.");
      }
      gaps_inserted += await saveExtractBatch({ page, kind: "need", run_id: result.run_id,
        claims: result.output.gaps.map((gap) => ({
          claim_type: "gap", statement: gap.statement, status: "draft", provenance: gap.provenance,
          metadata: {
            origin: "need_extract", source_badge: "extract", external_id: gap.external_id,
            si_theme: siThemeFromGapId(gap.external_id)?.slug ?? null,
            reference_pack_id: source.reference_pack_id ?? null,
          },
        })),
      });
      runs.push({
        call_kind: "need_extract",
        run_id: result.run_id,
        summary: result.summary,
        count: result.output.gaps.length,
      });
    }

    if (kinds.includes("inventory") && !completed.has("inventory")) {
      const result = await runAccuracyModule<InventoryExtractOutput>({
        call_kind: "inventory_extract",
        agent_role: "proposer",
        input: {
          workspace_id: body.workspace_id,
          source_file_id: body.source_file_id,
          block_ids,
        },
        actor,
        org_id,
        workspace_id: body.workspace_id,
      });
      if (result.output.workspace_id !== body.workspace_id || result.output.source_file_id !== body.source_file_id) {
        throw new TrustedApplicationError("Extraction returned a different workspace or source.");
      }
      tactics_inserted += await saveExtractBatch({ page, kind: "inventory", run_id: result.run_id,
        claims: result.output.tactics.map((tactic) => ({
          claim_type: "tactic", statement: tactic.name, status: tactic.status, provenance: tactic.provenance,
          metadata: {
            origin: "inventory", source_badge: "extract", type: tactic.type,
            evidence_question: tactic.evidence_question, tactic_status: tactic.status,
            reference_pack_id: source.reference_pack_id ?? null,
          },
        })),
      });
      runs.push({
        call_kind: "inventory_extract",
        run_id: result.run_id,
        summary: result.summary,
        count: result.output.tactics.length,
      });
    }

    const mergeRun = await runAccuracyModule<MergeDedupeOutput>({
      call_kind: "merge_dedupe",
      agent_role: "judge",
      input: { workspace_id: body.workspace_id },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });
    runs.push({
      call_kind: "merge_dedupe",
      run_id: mergeRun.run_id,
      summary: mergeRun.summary,
      count: mergeRun.output.merged,
    });

    const statusRun = await runAccuracyModule<StatusDeriveOutput>({
      call_kind: "status_derive",
      agent_role: "none",
      input: { workspace_id: body.workspace_id },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });
    runs.push({
      call_kind: "status_derive",
      run_id: statusRun.run_id,
      summary: statusRun.summary,
      count: statusRun.output.statuses.length,
    });

    return NextResponse.json({
      ok: true,
      workspace_id: body.workspace_id,
      source_file_id: body.source_file_id,
      ...await extractPageProgress(page),
      gaps_inserted,
      tactics_inserted,
      merge: mergeRun.output,
      statuses: statusRun.output,
      runs,
      stub: gate.stub,
      provider_id: gate.stub ? null : gate.provider_id,
      provider_label: gate.stub ? null : gate.provider_label,
      auth: gate.stub ? null : gate.auth,
    });
  } catch (error) {
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    if (error instanceof NoRouteError) {
      const gate = await inspectLiveExtractGate();
      if (!gate.ready) {
        return NextResponse.json(extractKeyGateJson(gate), { status: 409 });
      }
    }
    if (error instanceof ExtractContinuationError) {
      return NextResponse.json({ ok: false, safe_error: true, error: error.message, code: "stale_continuation", status: "failed", restart_required: true }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "We couldn’t finish extracting claims. Check the source and current claims before extracting again.");
    return NextResponse.json({
      ...(page ? { ...await extractPageProgress(page), continuation: retryExtractContinuation(page) } : {}),
      ok: false, status: "failed", complete: false, error: message,
    }, { status: 400 });
  }
}
