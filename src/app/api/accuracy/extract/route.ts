import { extractSourcePages, SourceExtractionInputError, resolvedExtractionClaimIds, type SourceExtractOutput, type SourceExtractKind } from "@/accuracy/store/source-extraction";
import { getSourceFile } from "@/accuracy/store/source-store";
/** Extract source drafts, pause applied batches for review, and safely resume downstream work. */
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  extractKeyGateJson,
  inspectLiveExtractGate,
} from "@/accuracy/kernel/extract-gate";
import type { RejectedCandidate } from "@/accuracy/domain/structured-fields";
import { ItemHistoryError } from "@/accuracy/store/item-history-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { and, eq, inArray } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import * as tables from "@/accuracy/store/schema";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { resumeExtractionBatch, ExtractionBatchError } from "@/accuracy/store/extraction-batch-store";
import { requestIdentity, type RequestIdentity } from "@/modules/auth/request";
import { assertCan, ForbiddenError } from "@/modules/auth/roles";
import { NoRouteError } from "@/modules/llm/provider";
import { runExtractionDownstream } from "@/accuracy/experiments/extraction-pipeline";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import {
  labRequestErrorResponse,
  readLabJson,
  requireLabWorkspace,
} from "@/app/api/accuracy/_lib/request";
import { generateExtractionAssembly } from "@/accuracy/kernel/assembly-generation";
import { AssemblyError } from "@/accuracy/domain/assembly";
import { withAssemblyPreparation } from "@/accuracy/kernel/assembly-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  source_file_id: z.string().trim().min(1),
  cursor: z.string().trim().min(1).max(1024).optional(),
  block_ids: z.array(z.string().trim().min(1)).min(1).optional(),
  kinds: z
    .array(z.enum(["need", "inventory"]))
    .min(1)
    .default(["need", "inventory"]),
  /** Ignored: the run is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
}).strict();

const resumeSchema = z.object({ action: z.literal("resume"), workspace_id: z.string().min(1), source_file_id: z.string().min(1),
  extraction_batch_id: z.string().min(1), idempotency_key: z.string().trim().min(1),
  actor_name: z.string().min(1).optional(), actor_function: z.string().min(1).optional() }).strict();


async function assertAuthorizedWorkspace(identity: RequestIdentity, workspace_id: string) {
  if (!identity.subject) throw new AssemblyError("invalid_input", "Signed-in requests require a session subject.");
  if (!await getAuthorizedWorkspace({ workspace_id, subject: identity.subject, role: identity.role })) {
    throw new AssemblyError("not_found", "Workspace not found");
  }
}

async function attachAssembly<T extends { workspace_id: string; source_file_id: string; extraction_batch_id: string }>(response: T, args: {
  org_id: string;
  actor: RequestIdentity["actor"];
}) {
  const [batch] = await accuracyDb().select().from(tables.accuracyExtractionBatches).where(and(
    eq(tables.accuracyExtractionBatches.workspace_id, response.workspace_id),
    eq(tables.accuracyExtractionBatches.id, response.extraction_batch_id),
  ));
  if (!batch) throw new AssemblyError("not_found", "Extraction batch not found");
  const assembly = await generateExtractionAssembly({
    workspace_id: response.workspace_id,
    org_id: args.org_id,
    actor: args.actor,
    source_file_ids: [response.source_file_id],
    extraction_run_ids: batch.run_ids,
    requested_kinds: batch.requested_kinds as Array<"need_extract" | "inventory_extract">,
    generation_key: batch.id,
  });
  return { ...response, assembly_id: assembly.id, assembly_checks: assembly.checks };
}

function assemblyIncompleteResponse<T extends { extraction_batch_id: string; runs?: unknown; gaps_inserted?: number; tactics_inserted?: number }>(response: T, error: unknown) {
  console.error("Extraction assembly generation failed", error);
  return NextResponse.json({
    ...response,
    ok: false,
    assembly_incomplete: true,
    error: "Complete proposal linking failed. Retry resume to finish the saved extraction batch.",
  }, { status: 500 });
}

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
      const identity = await requestIdentity(raw ?? undefined);
      if (!identity.signed_in) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
      assertCan(identity.role, "validate");
      const request = resumeSchema.parse(raw);
      const { org_id } = await requireLabWorkspace(request.workspace_id);
      const actor = identity.actor;
      await assertAuthorizedWorkspace(identity, request.workspace_id);
      const response = await resumeExtractionBatch({ workspace_id: request.workspace_id, source_file_id: request.source_file_id,
        batch_id: request.extraction_batch_id, merge_context: { org_id, actor }, execute: async (batch, journal, prepared) => {
          await assertAccuracyCanProgress(request.workspace_id, "merge_dedupe");
          const extractionRuns = await accuracyDb().select().from(tables.accuracyModuleRuns).where(and(
            eq(tables.accuracyModuleRuns.workspace_id, request.workspace_id), inArray(tables.accuracyModuleRuns.id, batch.run_ids)));
          const runs = batch.run_ids.map(id => {
            const run = extractionRuns.find(row => row.id === id)!;
            const output = run.output as { gaps?: unknown[]; tactics?: unknown[]; rejected_candidates?: RejectedCandidate[] };
            return { call_kind: run.call_kind, run_id: id, summary: run.summary, count: output.gaps?.length ?? output.tactics?.length ?? 0,
              ...(output.rejected_candidates?.length ? { rejected_candidates: output.rejected_candidates } : {}) };
          });
          const downstream = await withAssemblyPreparation(() => runExtractionDownstream({ workspace_id: request.workspace_id, org_id, actor,
            merge_id: journal.merge_operation_id, status_id: journal.status_operation_id, prepared_merge: prepared }));
          return { ok: true, workspace_id: request.workspace_id, source_file_id: request.source_file_id,
            extraction_batch_id: batch.id, source_progress: batch.source_progress, claim_ids: resolvedExtractionClaimIds(batch.created_claim_ids, downstream.merge.output.merges), gaps_inserted: runs.filter(run => run.call_kind === "need_extract").reduce((sum, run) => sum + run.count, 0),
            tactics_inserted: runs.filter(run => run.call_kind === "inventory_extract").reduce((sum, run) => sum + run.count, 0),
            merge: downstream.merge.output, statuses: downstream.status.output, runs: [...runs, ...downstream.runs] };
        } });
      try {
        return NextResponse.json(await attachAssembly(response, { org_id, actor: identity.actor }));
      } catch (error) {
        if (error instanceof AssemblyError) throw error;
        return assemblyIncompleteResponse(response, error);
      }
    }
    const body = bodySchema.parse(raw);
    const { org_id } = await requireLabWorkspace(body.workspace_id);
    const identity = await requestIdentity(raw ?? undefined);
    if (!identity.signed_in) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    assertCan(identity.role, "validate");
    await assertAuthorizedWorkspace(identity, body.workspace_id);

    if (!await getSourceFile(body.workspace_id, body.source_file_id)) return NextResponse.json({ ok: false, error: "Unknown source_file_id" }, { status: 404 });

    const gate = await inspectLiveExtractGate();
    if (!gate.ready) {
      return NextResponse.json(extractKeyGateJson(gate), { status: 409 });
    }

    const actor = identity.actor;

    const extracted = await extractSourcePages({ workspace_id: body.workspace_id, source_file_id: body.source_file_id,
      kinds: body.kinds.map(kind => `${kind}_extract` as SourceExtractKind), block_ids: body.block_ids, cursor: body.cursor,
      run: (call_kind, input, reserved_run_id) => runAccuracyModule<SourceExtractOutput>({ call_kind, input, reserved_run_id,
        agent_role: "proposer", actor, org_id, workspace_id: body.workspace_id }) });
    const { batch, runs } = extracted;
    const source_progress = batch.source_progress!;
    const gaps_inserted = runs.filter(run => run.call_kind === "need_extract").reduce((n, run) => n + run.count, 0);
    const tactics_inserted = runs.filter(run => run.call_kind === "inventory_extract").reduce((n, run) => n + run.count, 0);
    const outcome = { extraction_batch_id: batch.id, claim_ids: batch.created_claim_ids, source_progress, runs, gaps_inserted, tactics_inserted };
    if (!source_progress.complete) {
      const aiOff = aiOffFromError(extracted.failure) ?? await refuseWhenAiOff();
      if (aiOff) return NextResponse.json({ ...await aiOff.json(), incomplete: true, ...outcome }, { status: 409 });
      return NextResponse.json({ ok: false, incomplete: true, ...outcome,
        error: extracted.failure instanceof Error ? extracted.failure.message : "Declared source pages or upstream parse units are incomplete." }, { status: 409 });
    }
    try {
      await assertAccuracyCanProgress(body.workspace_id, "merge_dedupe");
      const response = await resumeExtractionBatch({ workspace_id: body.workspace_id, source_file_id: body.source_file_id,
        batch_id: batch.id, merge_context: { org_id, actor }, execute: async (_batch, journal, prepared) => {
          await assertAccuracyCanProgress(body.workspace_id, "merge_dedupe");
          const downstream = await withAssemblyPreparation(() => runExtractionDownstream({ workspace_id: body.workspace_id, org_id, actor,
            merge_id: journal.merge_operation_id, status_id: journal.status_operation_id, prepared_merge: prepared }));
          return { ok: true, workspace_id: body.workspace_id, source_file_id: body.source_file_id,
            extraction_batch_id: batch.id, claim_ids: resolvedExtractionClaimIds(batch.created_claim_ids, downstream.merge.output.merges), source_progress, block_count: source_progress.expected_blocks, blocks_used: source_progress.block_ids.length,
            gaps_inserted, tactics_inserted, merge: downstream.merge.output, statuses: downstream.status.output,
            runs: [...runs, ...downstream.runs], stub: gate.stub, provider_id: gate.stub ? null : gate.provider_id,
            provider_label: gate.stub ? null : gate.provider_label, auth: gate.stub ? null : gate.auth };
        } });
      try {
        return NextResponse.json(await attachAssembly(response, { org_id, actor }));
      } catch (error) {
        if (error instanceof AssemblyError) throw error;
        return assemblyIncompleteResponse(response, error);
      }
    } catch (error) {
      if (error instanceof AccuracyPausedError) return NextResponse.json({ ok: false, paused: true, blockers: error.blockers,
        ...outcome }, { status: 409 });
      throw error;
    }
  } catch (error) {
    if (error instanceof SourceExtractionInputError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    if (error instanceof SyntaxError) return NextResponse.json({ ok: false, error: "Invalid JSON request." }, { status: 400 });
    if (error instanceof z.ZodError) return NextResponse.json({ ok: false, error: error.issues.map(issue => issue.message).join("; ") }, { status: 400 });
    if (error instanceof ItemHistoryError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400 });
    if (error instanceof AssemblyError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400 });
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
    console.error("Extraction or resume failed", error);
    return NextResponse.json({ ok: false, error: "Extraction or resume failed. Retry the saved batch." }, { status: 500 });
  }
}
