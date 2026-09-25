import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { toParseBlockPreviews } from "@/accuracy/store/parse-preview";
import {
  PARSE_BLOCK_KINDS,
  ProvenanceConflictError,
  addParseBlock,
  createManualSource,
  deleteParseBlock,
  editParseBlock,
  listDroppedUnits,
  listParseBlockEdits,
  mergeParseBlocks,
  readParseBlocksWithMeta,
  readSourceStakeholder,
  restoreDroppedUnit,
  setSourceStakeholder,
  splitParseBlock,
} from "@/accuracy/store/parse-store";
import { getSourceFile } from "@/accuracy/store/source-store";
import { getWorkspace, getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { STAKEHOLDER_FUNCTIONS } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/**
 * Verbatim parse-block preview for one source file, with who made each block
 * (model or human), the claims that quote it, the units the model dropped as
 * noise, the stakeholder classification and the edit trail.
 * Scoped to workspace + source so BeOne gold packs never mix.
 */
export async function GET(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get("workspace_id")?.trim() ?? "";
  const source_file_id = url.searchParams.get("source_file_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
  if (!source_file_id) {
    return NextResponse.json({ error: "source_file_id required" }, { status: 400 });
  }

  const workspace = await getWorkspace(workspace_id);
  if (!workspace) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
  }
  const source = await getSourceFile(workspace_id, source_file_id);
  if (!source) {
    return NextResponse.json({ error: "Unknown source file" }, { status: 404 });
  }

  const stored = await readParseBlocksWithMeta(workspace_id, source_file_id);
  const [dropped, stakeholder, edits] = await Promise.all([
    listDroppedUnits(workspace_id, source_file_id),
    readSourceStakeholder(workspace_id, source_file_id),
    listParseBlockEdits(workspace_id, source_file_id),
  ]);
  return NextResponse.json({
    ok: true,
    workspace_id,
    source_file_id,
    filename: source.filename,
    reference_pack_id: source.reference_pack_id,
    block_count: stored.length,
    blocks: toParseBlockPreviews(stored).map((preview) => ({
      ...preview,
      provenance: stored.find((block) => block.id === preview.id)!.provenance,
    })),
    dropped,
    stakeholder,
    edits,
  });
}

const actorFields = {
  workspace_id: z.string().min(1),
  rationale: z.string(),
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
};
const kind = z.enum(PARSE_BLOCK_KINDS);
const optionalOffset = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : Number(value)),
  z.number().int().optional(),
);
const heading = z.string().nullable().optional();

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("edit"),
    block_id: z.string().min(1),
    text: z.string().optional(),
    kind: kind.optional(),
    heading,
    ...actorFields,
  }),
  z.object({
    action: z.literal("split"),
    block_id: z.string().min(1),
    offset: optionalOffset,
    at_text: z.string().optional(),
    ...actorFields,
  }),
  z.object({
    action: z.literal("merge"),
    block_id: z.string().min(1),
    next_block_id: z.string().optional(),
    ...actorFields,
  }),
  z.object({ action: z.literal("delete"), block_id: z.string().min(1), ...actorFields }),
  z.object({
    action: z.literal("add"),
    source_file_id: z.string().min(1),
    after_block_id: z.string().nullable().optional(),
    text: z.string(),
    kind: kind.optional(),
    heading,
    ...actorFields,
  }),
  z.object({
    action: z.literal("restore_dropped"),
    dropped_id: z.string().min(1),
    after_block_id: z.string().nullable().optional(),
    kind: kind.optional(),
    heading,
    ...actorFields,
  }),
  z.object({
    action: z.literal("set_stakeholder"),
    source_file_id: z.string().min(1),
    stakeholder_function: z.enum(STAKEHOLDER_FUNCTIONS),
    ...actorFields,
  }),
  z.object({
    action: z.literal("manual_source"),
    filename: z.string().default(""),
    doc_role: z.string().optional(),
    stakeholder_function: z.enum(STAKEHOLDER_FUNCTIONS).optional().nullable(),
    blocks: z.array(z.object({ text: z.string(), kind: kind.optional(), heading })).min(1),
    ...actorFields,
  }),
]);

/**
 * POST /api/accuracy/sources/blocks — human block edits. Every action needs a
 * rationale (3+ chars) and is written to the parse-block audit trail. An edit
 * that would orphan a claim's quote is refused with 409 and the claim ids.
 */
export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Invalid body";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
  const org_id = await getWorkspaceOrgId(body.workspace_id);
  if (!org_id) return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
  const actor = {
    name: body.actor_name?.trim() || "Accuracy reviewer",
    function: body.actor_function?.trim() || "medical_affairs",
  };
  const base = { workspace_id: body.workspace_id, rationale: body.rationale, actor };
  try {
    switch (body.action) {
      case "edit":
        return NextResponse.json({
          ok: true,
          block: await editParseBlock({ ...base, block_id: body.block_id, text: body.text, kind: body.kind, heading: body.heading }),
        });
      case "split":
        return NextResponse.json({
          ok: true,
          ...(await splitParseBlock({ ...base, block_id: body.block_id, offset: body.offset, at_text: body.at_text })),
        });
      case "merge":
        return NextResponse.json({
          ok: true,
          ...(await mergeParseBlocks({ ...base, block_id: body.block_id, next_block_id: body.next_block_id })),
        });
      case "delete":
        return NextResponse.json({ ok: true, ...(await deleteParseBlock({ ...base, block_id: body.block_id })) });
      case "add":
        return NextResponse.json({
          ok: true,
          block: await addParseBlock({
            ...base,
            source_file_id: body.source_file_id,
            after_block_id: body.after_block_id === "" ? undefined : body.after_block_id,
            text: body.text,
            kind: body.kind,
            heading: body.heading,
          }),
        });
      case "restore_dropped":
        return NextResponse.json({
          ok: true,
          block: await restoreDroppedUnit({
            ...base,
            dropped_id: body.dropped_id,
            after_block_id: body.after_block_id === "" ? undefined : body.after_block_id,
            kind: body.kind,
            heading: body.heading,
          }),
        });
      case "set_stakeholder":
        return NextResponse.json({
          ok: true,
          stakeholder: await setSourceStakeholder({
            ...base,
            source_file_id: body.source_file_id,
            stakeholder_function: body.stakeholder_function,
          }),
        });
      case "manual_source": {
        const created = await createManualSource({
          ...base,
          org_id,
          filename: body.filename,
          doc_role: body.doc_role,
          stakeholder_function: body.stakeholder_function ?? null,
          blocks: body.blocks,
        });
        return NextResponse.json({ ok: true, source_file_id: created.source.id, block_ids: created.block_ids });
      }
    }
  } catch (error) {
    if (error instanceof ProvenanceConflictError) {
      return NextResponse.json(
        { ok: false, error: error.message, orphaned_claims: error.orphans.map((o) => o.id) },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Block edit failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
