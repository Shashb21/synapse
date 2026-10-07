/** Extract source drafts, pause applied batches for review, and safely resume downstream work. */
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
import { insertClaim } from "@/accuracy/store/claim-store";
import { readParseBlocks } from "@/accuracy/store/parse-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { siThemeFromGapId } from "@/accuracy/domain/ledger-filters";
import { and, eq, inArray } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import * as tables from "@/accuracy/store/schema";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { createExtractionBatch, applyExtractionBatch, resumeExtractionBatch, ExtractionBatchError } from "@/accuracy/store/extraction-batch-store";
import { requestIdentity } from "@/modules/auth/request";
import { assertCan, ForbiddenError } from "@/modules/auth/roles";
import { NoRouteError } from "@/modules/llm/provider";
import { runExtractionDownstream } from "@/accuracy/experiments/extraction-pipeline";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import {
  labActor,
  labErrorMessage,
  labRequestErrorResponse,
  readLabJson,
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
  /** Ignored: the run is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
});

const resumeSchema = z.object({ action: z.literal("resume"), workspace_id: z.string().min(1), source_file_id: z.string().min(1),
  extraction_batch_id: z.string().min(1), idempotency_key: z.string().trim().min(1) });

const MAX_EXTRACT_BLOCKS = 80;

/**
 * Run need_extract and/or inventory_extract for a source file's parse blocks,
 * persist resulting claims, then merge/dedupe and derive Open/Partial/Addressed.
 */
export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const raw = await readLabJson(req) as Record<string, unknown> | null;
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    if (raw && raw.action === "resume") {
      const identity = await requestIdentity(raw);
      if (!identity.signed_in && !identity.demo) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
      assertCan(identity.role, "validate");
      const request = resumeSchema.parse(raw);
      const { org_id } = await requireLabWorkspace(request.workspace_id);
      const actor = await labActor();
      const response = await resumeExtractionBatch({ workspace_id: request.workspace_id, source_file_id: request.source_file_id,
        batch_id: request.extraction_batch_id, execute: async (batch, journal) => {
          await assertAccuracyCanProgress(request.workspace_id, "merge_dedupe");
          const extractionRuns = await accuracyDb().select().from(tables.accuracyModuleRuns).where(and(
            eq(tables.accuracyModuleRuns.workspace_id, request.workspace_id), inArray(tables.accuracyModuleRuns.id, batch.run_ids)));
          const runs = batch.run_ids.map(id => {
            const run = extractionRuns.find(row => row.id === id)!;
            const output = run.output as { gaps?: unknown[]; tactics?: unknown[] };
            return { call_kind: run.call_kind, run_id: id, summary: run.summary, count: output.gaps?.length ?? output.tactics?.length ?? 0 };
          });
          const downstream = await runExtractionDownstream({ workspace_id: request.workspace_id, org_id, actor,
            merge_id: journal.merge_operation_id, status_id: journal.status_operation_id });
          return { ok: true, workspace_id: request.workspace_id, source_file_id: request.source_file_id,
            extraction_batch_id: batch.id, gaps_inserted: runs.filter(run => run.call_kind === "need_extract").reduce((sum, run) => sum + run.count, 0),
            tactics_inserted: runs.filter(run => run.call_kind === "inventory_extract").reduce((sum, run) => sum + run.count, 0),
            merge: downstream.merge.output, statuses: downstream.status.output, runs: [...runs, ...downstream.runs] };
        } });
      return NextResponse.json(response);
    }
    const body = bodySchema.parse(raw);
    const { org_id } = await requireLabWorkspace(body.workspace_id);

    const sources = await listSourceFiles(body.workspace_id);
    const source = sources.find((row) => row.id === body.source_file_id);
    if (!source) {
      return NextResponse.json({ ok: false, error: "Unknown source_file_id" }, { status: 404 });
    }

    const allBlocks = await readParseBlocks(body.workspace_id, body.source_file_id);
    if (allBlocks.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "No parse blocks for this source — upload/re-parse before extracting.",
        },
        { status: 400 },
      );
    }

    const sorted = [...allBlocks].sort((a, b) => a.index - b.index);
    const blocks = sorted.slice(0, MAX_EXTRACT_BLOCKS);
    const block_ids = blocks.map((b) => b.id);

    const gate = await inspectLiveExtractGate();
    if (!gate.ready) {
      return NextResponse.json(extractKeyGateJson(gate), { status: 409 });
    }

    const actor = await labActor();

    const kinds = body.kinds;
    const batch = await createExtractionBatch(body.workspace_id, body.source_file_id, kinds.map(kind => `${kind}_extract`));
    const created_claim_ids: string[] = [];
    const draftClaims: Array<Parameters<typeof insertClaim>[0]> = [];
    let gaps_inserted = 0;
    let tactics_inserted = 0;
    const runs: Array<{
      call_kind: string;
      run_id: string;
      summary: string;
      count: number;
    }> = [];

    if (kinds.includes("need")) {
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
      for (const gap of result.output.gaps) {
        draftClaims.push({
          id: gap.id,
          workspace_id: body.workspace_id,
          claim_type: "gap",
          statement: gap.statement,
          status: "draft",
          validated: false,
          source_file_id: body.source_file_id,
          metadata: {
            origin: "need_extract",
            source_badge: "extract",
            external_id: gap.external_id,
            si_theme: siThemeFromGapId(gap.external_id)?.slug ?? null,
            provenance: gap.provenance,
            reference_pack_id: source.reference_pack_id ?? null,
          },
        });
        created_claim_ids.push(gap.id);
        gaps_inserted += 1;
      }
      runs.push({
        call_kind: "need_extract",
        run_id: result.run_id,
        summary: result.summary,
        count: result.output.gaps.length,
      });
    }

    if (kinds.includes("inventory")) {
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
      for (const tactic of result.output.tactics) {
        draftClaims.push({
          id: tactic.id,
          workspace_id: body.workspace_id,
          claim_type: "tactic",
          statement: tactic.name,
          status: tactic.status,
          validated: false,
          source_file_id: body.source_file_id,
          metadata: {
            origin: "inventory",
            source_badge: "extract",
            type: tactic.type,
            evidence_question: tactic.evidence_question,
            provenance: tactic.provenance,
            tactic_status: tactic.status,
            reference_pack_id: source.reference_pack_id ?? null,
          },
        });
        created_claim_ids.push(tactic.id);
        tactics_inserted += 1;
      }
      runs.push({
        call_kind: "inventory_extract",
        run_id: result.run_id,
        summary: result.summary,
        count: result.output.tactics.length,
      });
    }

    await applyExtractionBatch(batch, runs.map(run => run.run_id), created_claim_ids, async () => {
      for (const claim of draftClaims) await insertClaim(claim);
    });
    try {
      const response = await resumeExtractionBatch({ workspace_id: body.workspace_id, source_file_id: body.source_file_id,
        batch_id: batch.id, execute: async (_batch, journal) => {
          await assertAccuracyCanProgress(body.workspace_id, "merge_dedupe");
          const downstream = await runExtractionDownstream({ workspace_id: body.workspace_id, org_id, actor,
            merge_id: journal.merge_operation_id, status_id: journal.status_operation_id });
          return { ok: true, workspace_id: body.workspace_id, source_file_id: body.source_file_id,
            extraction_batch_id: batch.id, block_count: allBlocks.length, blocks_used: blocks.length,
            gaps_inserted, tactics_inserted, merge: downstream.merge.output, statuses: downstream.status.output,
            runs: [...runs, ...downstream.runs], stub: gate.stub, provider_id: gate.stub ? null : gate.provider_id,
            provider_label: gate.stub ? null : gate.provider_label, auth: gate.stub ? null : gate.auth };
        } });
      return NextResponse.json(response);
    } catch (error) {
      if (error instanceof AccuracyPausedError) return NextResponse.json({ ok: false, paused: true, blockers: error.blockers,
        extraction_batch_id: batch.id, runs, gaps_inserted, tactics_inserted }, { status: 409 });
      throw error;
    }
  } catch (error) {
    if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ExtractionBatchError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 409 });
    if (error instanceof AccuracyPausedError) return NextResponse.json({ ok: false, paused: true, blockers: error.blockers }, { status: 409 });
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    if (error instanceof NoRouteError) {
      const gate = await inspectLiveExtractGate();
      if (!gate.ready) {
        return NextResponse.json(extractKeyGateJson(gate), { status: 409 });
      }
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Extract failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
