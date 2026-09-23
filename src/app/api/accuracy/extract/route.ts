import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  extractOauthGateJson,
  inspectLiveExtractGate,
} from "@/accuracy/kernel/extract-gate";
import type { NeedExtractOutput } from "@/accuracy/modules/need-extract/module";
import type { InventoryExtractOutput } from "@/accuracy/modules/inventory-extract/module";
import type { MergeDedupeOutput } from "@/accuracy/modules/merge-dedupe/module";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
import { insertClaim } from "@/accuracy/store/claim-store";
import { readParseBlocks } from "@/accuracy/store/parse-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { siThemeFromGapId } from "@/accuracy/domain/ledger-filters";
import { NoRouteError } from "@/modules/llm/provider";

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
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
});

const MAX_EXTRACT_BLOCKS = 80;

/**
 * Run need_extract and/or inventory_extract for a source file's parse blocks,
 * persist resulting claims, then merge/dedupe and derive Open/Partial/Addressed.
 */
export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

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
      return NextResponse.json(extractOauthGateJson(gate), { status: 409 });
    }

    const actor = {
      name: body.actor_name?.trim() || "Accuracy extractor",
      function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
    };

    const kinds = body.kinds;
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
        await insertClaim({
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
        await insertClaim({
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
        tactics_inserted += 1;
      }
      runs.push({
        call_kind: "inventory_extract",
        run_id: result.run_id,
        summary: result.summary,
        count: result.output.tactics.length,
      });
    }

    const mergeRun = await runAccuracyModule<MergeDedupeOutput>({
      call_kind: "merge_dedupe",
      agent_role: "none",
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
      block_count: allBlocks.length,
      blocks_used: blocks.length,
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
    if (error instanceof NoRouteError) {
      const gate = await inspectLiveExtractGate();
      if (!gate.ready) {
        return NextResponse.json(extractOauthGateJson(gate), { status: 409 });
      }
    }
    const message = error instanceof Error ? error.message : "Extract failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
