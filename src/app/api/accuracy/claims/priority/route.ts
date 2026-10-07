import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerGate } from "@/modules/auth/owner";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { CLAIM_PRIORITIES, updateClaim } from "@/accuracy/store/claim-edit";
import { actorFieldsSchema } from "@/accuracy/store/claim-patch-schema";
import { listAccuracyPlacements, loadAccuracyPriorityConfig, readAccuracyPriorityInputs, setAccuracyPlacement, saveAccuracyPriorityConfig, PriorityError, priorityContextSchema, priorityConsiderationsSchema } from "@/accuracy/store/priority-store";
import { accuracyPrioritizeInputSchema, type AccuracyPriorityOutput } from "@/accuracy/modules/prioritize/module";
import { labActor, labRequestErrorResponse, parseLabBody, requireLabWorkspace } from "@/app/api/accuracy/_lib/request";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
registerAccuracyStack();
const band = z.enum(["high", "medium", "low", "defer"]);
const base = { workspace_id: z.string().min(1), rationale: z.string().trim().min(3), ...actorFieldsSchema };
const selection = { x_axis: z.string().optional(), y_axis: z.string().optional(), setting: z.string().optional(), context: priorityContextSchema.optional() };
const tokens = { expected_input_revision: z.string().min(1), expected_config_revision: z.string().min(1) };
const schema = z.union([
  z.object({ ...base, action: z.enum(["set", "validate"]), gap_id: z.string().min(1), band: band.optional(), axis_scores: z.record(z.string(), z.number().min(0).max(100)).optional(), validate: z.boolean().optional(), ...selection, ...tokens })
    .refine(b => b.action !== "validate" || b.band !== undefined, { message: "A band is required for validation", path: ["band"] }),
  accuracyPrioritizeInputSchema.extend({ action: z.literal("suggest") }),
  z.object({ ...base, action: z.literal("configure"), context: priorityContextSchema.optional(), considerations: priorityConsiderationsSchema.optional(), config: z.unknown().optional(), scope: z.string().optional(), x_axis: z.string().optional(), y_axis: z.string().optional(), expected_config_revision: z.string().min(1) }),
  z.object({ ...base, claim_id: z.string().min(1), priority: z.enum(CLAIM_PRIORITIES) }),
]);
function errorResponse(error: unknown) {
  const aiOff = aiOffFromError(error); if (aiOff) return aiOff;
  const known = labRequestErrorResponse(error); if (known) return known;
  if (error instanceof AccuracyPausedError) return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
  if (error instanceof PriorityError) return NextResponse.json({ ok: false, error: error.message, code: error.code }, {
    status: error.code.startsWith("unknown_") ? 404 : ["ineligible_gap", "stale_revision"].includes(error.code) ? 409 : 400,
  });
  return NextResponse.json({ ok: false, error: "Priority action failed" }, { status: 500 });
}
export async function GET(req: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const params = new URL(req.url).searchParams;
    const workspace_id = z.string().min(1).parse(params.get("workspace_id"));
    await requireLabWorkspace(workspace_id);
    const config = await loadAccuracyPriorityConfig(workspace_id, params.get("setting") ?? undefined);
    const placements = await listAccuracyPlacements(workspace_id);
    const gap_id = params.get("gap_id");
    if (!gap_id) return NextResponse.json({ ok: true, config, placements });
    const input = await readAccuracyPriorityInputs({ workspace_id, gap_id, setting: params.get("setting") ?? undefined, x_axis: params.get("x_axis") ?? undefined, y_axis: params.get("y_axis") ?? undefined });
    return NextResponse.json({ ok: true, config, placements, gap_id, eligible: !input.reason, skipped_reason: input.reason,
      expected_input_revision: input.input_revision, expected_config_revision: input.config_revision,
      axes: input.axes, x_axis: input.xAxis.id, y_axis: input.yAxis.id, pair_chosen: input.pairChosen,
      context: input.context, considerations: input.considerations, references: input.references, limitations: input.limitations });
  } catch (error) { return errorResponse(error); }
}
export async function POST(req: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const body = await parseLabBody(req, schema), workspace = await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "prioritize");
    const actor = await labActor();
    if ("action" in body) {
      if (body.action === "suggest") {
        const aiOff = await refuseWhenAiOff(); if (aiOff) return aiOff;
        const result = await runAccuracyModule<AccuracyPriorityOutput>({ call_kind: "prioritize", agent_role: "proposer", input: body,
          actor, org_id: workspace.org_id, workspace_id: body.workspace_id });
        return NextResponse.json({ ok: true, ...result.output, run_id: result.run_id });
      }
      if (body.action === "configure") return NextResponse.json({ ok: true, config: await saveAccuracyPriorityConfig({ ...body, actor }) });
      return NextResponse.json({ ok: true, placement: await setAccuracyPlacement({ ...body, actor, validate: body.action === "validate" || body.validate }) });
    }
    // Compatibility metadata edits remain draft-capable and keep their existing locks.
    // They do not grant authoritative S8 placement validation.
    try {
      const result = await updateClaim({ workspace_id: body.workspace_id, claim_id: body.claim_id, patch: { priority: body.priority }, rationale: body.rationale, actor });
      return NextResponse.json({ ok: true, changed: result.changed });
    } catch (error) {
      if (error instanceof Error && error.message === "No changes to save.") return NextResponse.json({ ok: true, changed: [] });
      if (error instanceof Error && /^Unknown claim/.test(error.message)) throw new PriorityError("unknown_gap", "Claim not found");
      throw error;
    }
  } catch (error) { return errorResponse(error); }
}
