import { NextResponse } from "next/server";
import { z } from "zod";
import { ACTOR_FUNCTIONS, SOURCE_TYPES } from "@/lib/iegp/enums";
import {
  SourceQuoteConflictError,
  addSourceBlock,
  createManualSource,
  deleteSourceBlock,
  editSourceBlock,
  generationOf,
  listDroppedSourceUnits,
  listSourceBlocks,
  mergeSourceBlocks,
  readSourceStakeholder,
  restoreDroppedSourceUnit,
  setSourceStakeholder,
  splitSourceBlock,
} from "@/lib/iegp/source-blocks";
import { listEdits } from "@/modules/kernel/edit-records";
import { apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import type { Actor } from "@/modules/kernel/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sources/blocks?source_id= — blocks in order with human/model provenance. */
export async function GET(req: Request) {
  const source_id = new URL(req.url).searchParams.get("source_id")?.trim() ?? "";
  if (!source_id) return NextResponse.json({ error: "source_id required" }, { status: 400 });
  try {
    await requireCustomerContext();
  } catch (error) {
    return apiErrorResponse(error);
  }
  try {
    const stakeholder = await readSourceStakeholder(source_id);
    const [blocks, dropped] = await Promise.all([listSourceBlocks(source_id), listDroppedSourceUnits(source_id)]);
    // Source ids are reused after a reset; only edits made since this source was ingested belong to it.
    const since = (await generationOf(source_id)) ?? "";
    const edits = (await listEdits({ stage: "S1", limit: 500 })).filter(
      (edit) => (edit.entity_id === source_id || edit.entity_id.startsWith(`${source_id}-`)) && edit.at >= since,
    );
    return NextResponse.json({ ok: true, source_id, blocks, dropped, stakeholder, edits });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Not found" }, { status: 404 });
  }
}

const common = {
  rationale: z.string(),
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
};
const optionalOffset = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : Number(value)),
  z.number().int().optional(),
);
const afterBlock = z.preprocess((value) => (value === "" ? undefined : value), z.string().nullable().optional());

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("edit"),
    block_id: z.string().min(1),
    text: z.string().optional(),
    heading: z.string().optional(),
    location: z.string().optional(),
    ...common,
  }),
  z.object({
    action: z.literal("split"),
    block_id: z.string().min(1),
    offset: optionalOffset,
    at_text: z.string().optional(),
    ...common,
  }),
  z.object({ action: z.literal("merge"), block_id: z.string().min(1), ...common }),
  z.object({ action: z.literal("delete"), block_id: z.string().min(1), ...common }),
  z.object({
    action: z.literal("add"),
    source_id: z.string().min(1),
    after_block_id: afterBlock,
    text: z.string(),
    heading: z.string().optional(),
    location: z.string().optional(),
    ...common,
  }),
  z.object({
    action: z.literal("restore_dropped"),
    dropped_id: z.string().min(1),
    after_block_id: afterBlock,
    heading: z.string().optional(),
    ...common,
  }),
  z.object({
    action: z.literal("set_stakeholder"),
    source_id: z.string().min(1),
    stakeholder_function: z.enum(ACTOR_FUNCTIONS),
    ...common,
  }),
  z.object({
    action: z.literal("manual_source"),
    title: z.string(),
    source_type: z.enum(SOURCE_TYPES),
    stakeholder_function: z.enum(ACTOR_FUNCTIONS),
    blocks: z.array(z.object({ text: z.string(), heading: z.string().optional() })).min(1),
    ...common,
  }),
]);

/**
 * POST /api/sources/blocks — human edits to S1 source blocks. Rationale (3+
 * chars) required; every change is an edit record + audit row. An edit that
 * would orphan a need's quote is refused with 409 and the need ids.
 */
export async function POST(req: Request) {
  let raw: Record<string, unknown>;
  let actor: Actor;
  try {
    raw = await readJsonBody(req);
    // S1 source edits are upload work: viewers may not change blocks. The actor is the signed-in person.
    ({ actor } = await requireCustomerContext({ body: raw, capability: "upload" }));
  } catch (error) {
    return apiErrorResponse(error);
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const base = { rationale: body.rationale, actor };
  try {
    switch (body.action) {
      case "edit":
        return NextResponse.json({
          ok: true,
          block: await editSourceBlock({ ...base, block_id: body.block_id, text: body.text, heading: body.heading, location: body.location }),
        });
      case "split":
        return NextResponse.json({
          ok: true,
          ...(await splitSourceBlock({ ...base, block_id: body.block_id, offset: body.offset, at_text: body.at_text })),
        });
      case "merge":
        return NextResponse.json({ ok: true, ...(await mergeSourceBlocks({ ...base, block_id: body.block_id })) });
      case "delete":
        return NextResponse.json({ ok: true, ...(await deleteSourceBlock({ ...base, block_id: body.block_id })) });
      case "add":
        return NextResponse.json({
          ok: true,
          block: await addSourceBlock({
            ...base,
            source_id: body.source_id,
            after_block_id: body.after_block_id,
            text: body.text,
            heading: body.heading,
            location: body.location,
          }),
        });
      case "restore_dropped":
        return NextResponse.json({
          ok: true,
          block: await restoreDroppedSourceUnit({
            ...base,
            dropped_id: body.dropped_id,
            after_block_id: body.after_block_id,
            heading: body.heading,
          }),
        });
      case "set_stakeholder":
        return NextResponse.json({
          ok: true,
          stakeholder: await setSourceStakeholder({
            ...base,
            source_id: body.source_id,
            stakeholder_function: body.stakeholder_function,
          }),
        });
      case "manual_source": {
        const created = await createManualSource({
          ...base,
          title: body.title,
          source_type: body.source_type,
          stakeholder_function: body.stakeholder_function,
          blocks: body.blocks,
        });
        return NextResponse.json({ ok: true, source_id: created.source_id, block_ids: created.blocks.map((b) => b.id) });
      }
    }
  } catch (error) {
    if (error instanceof SourceQuoteConflictError) {
      return NextResponse.json({ error: error.message, orphaned_needs: error.orphans.map((o) => o.id) }, { status: 409 });
    }
    return apiErrorResponse(error, "Block edit failed");
  }
}
