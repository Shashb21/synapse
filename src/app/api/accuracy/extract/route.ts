import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { NeedExtractOutput } from "@/accuracy/modules/need-extract/module";
import type { InventoryExtractOutput } from "@/accuracy/modules/inventory-extract/module";
import type { MergeDedupeOutput } from "@/accuracy/modules/merge-dedupe/module";
import {
  claimToMergeCandidate,
  type MergeCandidate,
} from "@/accuracy/modules/merge-dedupe/engine";
import type { GapStatus } from "@/accuracy/modules/status-derive/engine";
import {
  claimMetadata,
  getClaim,
  insertClaim,
  listClaims,
  updateClaimMetadata,
  type AccuracyClaimMetadata,
} from "@/accuracy/store/claim-store";
import { readParseBlocks } from "@/accuracy/store/parse-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";

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

type PendingClaim = {
  candidate: MergeCandidate;
  insert: () => Promise<void>;
  provenance?: AccuracyClaimMetadata["provenance"];
};

async function foldProvenanceOntoExisting(args: {
  workspace_id: string;
  matched_id: string;
  provenance: unknown;
}) {
  const existing = await getClaim(args.workspace_id, args.matched_id);
  if (!existing) return;
  const meta = claimMetadata(existing);
  const prior = Array.isArray(meta.provenance) ? [...meta.provenance] : [];
  const incoming = Array.isArray(args.provenance) ? args.provenance : [];
  const seen = new Set(
    prior.map((p) => {
      const row = p as { block_id?: string; quote?: string };
      return `${row.block_id ?? ""}::${row.quote ?? ""}`;
    }),
  );
  let added = 0;
  for (const span of incoming) {
    const row = span as { block_id?: string; quote?: string };
    const key = `${row.block_id ?? ""}::${row.quote ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prior.push(span as never);
    added += 1;
  }
  if (added === 0) return;
  await updateClaimMetadata({
    workspace_id: args.workspace_id,
    claim_id: args.matched_id,
    metadata: { ...meta, provenance: prior },
  });
}

/**
 * Run need_extract and/or inventory_extract for a source file's parse blocks,
 * merge/dedupe against the ledger, persist new claims, then refresh gap statuses.
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
    const actor = {
      name: body.actor_name?.trim() || "Accuracy extractor",
      function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
    };

    const kinds = body.kinds;
    let gaps_inserted = 0;
    let tactics_inserted = 0;
    let gaps_merged = 0;
    let tactics_merged = 0;
    let gaps_skipped = 0;
    let tactics_skipped = 0;
    let contradictions = 0;
    const runs: Array<{
      call_kind: string;
      run_id: string;
      summary: string;
      count: number;
    }> = [];

    const pending: PendingClaim[] = [];

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
        const metadata: AccuracyClaimMetadata = {
          origin: "need_extract",
          source_badge: "extract",
          external_id: gap.external_id,
          provenance: gap.provenance,
        };
        pending.push({
          candidate: claimToMergeCandidate({
            id: gap.id,
            claim_type: "gap",
            statement: gap.statement,
            status: "draft",
            metadata,
          }),
          provenance: gap.provenance,
          insert: async () => {
            await insertClaim({
              id: gap.id,
              workspace_id: body.workspace_id,
              claim_type: "gap",
              statement: gap.statement,
              status: "draft",
              validated: false,
              source_file_id: body.source_file_id,
              metadata,
            });
            gaps_inserted += 1;
          },
        });
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
        const metadata: AccuracyClaimMetadata = {
          origin: "inventory",
          source_badge: "extract",
          type: tactic.type,
          evidence_question: tactic.evidence_question,
          provenance: tactic.provenance,
        };
        pending.push({
          candidate: claimToMergeCandidate({
            id: tactic.id,
            claim_type: "tactic",
            statement: tactic.name,
            status: tactic.status,
            metadata,
          }),
          provenance: tactic.provenance,
          insert: async () => {
            await insertClaim({
              id: tactic.id,
              workspace_id: body.workspace_id,
              claim_type: "tactic",
              statement: tactic.name,
              status: tactic.status,
              validated: false,
              source_file_id: body.source_file_id,
              metadata,
            });
            tactics_inserted += 1;
          },
        });
      }
      runs.push({
        call_kind: "inventory_extract",
        run_id: result.run_id,
        summary: result.summary,
        count: result.output.tactics.length,
      });
    }

    const existingClaims = await listClaims(body.workspace_id, { limit: 500 });
    const existing: MergeCandidate[] = existingClaims.map((row) =>
      claimToMergeCandidate({
        id: row.id,
        claim_type: row.claim_type === "tactic" ? "tactic" : "gap",
        statement: row.statement,
        status: row.status,
        metadata: claimMetadata(row) as Record<string, unknown>,
      }),
    );

    const mergeResult = await runAccuracyModule<MergeDedupeOutput>({
      call_kind: "merge_dedupe",
      input: {
        workspace_id: body.workspace_id,
        existing,
        incoming: pending.map((p) => p.candidate),
      },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });
    runs.push({
      call_kind: "merge_dedupe",
      run_id: mergeResult.run_id,
      summary: mergeResult.summary,
      count: mergeResult.output.decisions.length,
    });

    const pendingById = new Map(pending.map((p) => [p.candidate.id, p]));
    for (const decision of mergeResult.output.decisions) {
      const item = pendingById.get(decision.candidate_id);
      if (!item) continue;
      if (decision.action === "insert") {
        await item.insert();
        continue;
      }
      if (decision.action === "merge" && decision.matched_id) {
        await foldProvenanceOntoExisting({
          workspace_id: body.workspace_id,
          matched_id: decision.matched_id,
          provenance: item.provenance,
        });
        if (item.candidate.claim_type === "gap") gaps_merged += 1;
        else tactics_merged += 1;
        continue;
      }
      if (decision.action === "contradict") {
        contradictions += 1;
        continue;
      }
      if (item.candidate.claim_type === "gap") gaps_skipped += 1;
      else tactics_skipped += 1;
    }

    const statusResult = await runAccuracyModule<{
      statuses: Array<{ gap_id: string; status: GapStatus }>;
      updated: number;
    }>({
      call_kind: "status_derive",
      input: { workspace_id: body.workspace_id, persist: true },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });
    runs.push({
      call_kind: "status_derive",
      run_id: statusResult.run_id,
      summary: statusResult.summary,
      count: statusResult.output.statuses.length,
    });

    return NextResponse.json({
      ok: true,
      workspace_id: body.workspace_id,
      source_file_id: body.source_file_id,
      block_count: allBlocks.length,
      blocks_used: blocks.length,
      gaps_inserted,
      tactics_inserted,
      gaps_merged,
      tactics_merged,
      gaps_skipped,
      tactics_skipped,
      contradictions,
      statuses_updated: statusResult.output.updated,
      runs,
      stub: process.env.SYNAPSE_TEST_STUB_LLM === "1",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extract failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
