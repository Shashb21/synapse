import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { insertClaim, listClaims, type AccuracyClaimType } from "@/accuracy/store/claim-store";
import { createManualClaim, updateClaim } from "@/accuracy/store/claim-edit";
import {
  actorFieldsSchema,
  actorFromBody,
  claimPatchSchema,
} from "@/accuracy/store/claim-patch-schema";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspace_id = searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const claim_type = searchParams.get("claim_type")?.trim() as AccuracyClaimType | undefined;
  const claims = await listClaims(workspace_id, {
    claim_type: claim_type === "gap" || claim_type === "tactic" ? claim_type : undefined,
  });
  return NextResponse.json({ claims });
}

const insertSchema = z.object({
  workspace_id: z.string().min(1),
  claim_type: z.enum(["gap", "tactic"]),
  statement: z.string().min(1),
  status: z.string().optional(),
  validated: z.boolean().optional(),
  source_file_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Manual entry: when a rationale is given the claim is created as a
   * human-authored record (origin `manual`, fields human-locked, audit entry).
   */
  rationale: z.string().optional(),
  fields: claimPatchSchema.omit({ statement: true }).optional(),
  ...actorFieldsSchema,
});

/**
 * POST /api/accuracy/claims
 * - With `rationale`: manual create (no AI). `fields` carries typed metadata
 *   (tactic type/status/evidence_question/dates/depends_on, gap external_id, quote, …).
 * - Without: raw seed insert (tests and early pipeline wiring).
 */
export async function POST(request: Request) {
  try {
    const body = insertSchema.parse(await request.json());
    if (body.rationale !== undefined) {
      if (body.validated) {
        return NextResponse.json(
          { error: "Validate a manual claim through the validation gate, not on create." },
          { status: 400 },
        );
      }
      const claim = await createManualClaim({
        workspace_id: body.workspace_id,
        claim_type: body.claim_type,
        statement: body.statement,
        rationale: body.rationale,
        actor: actorFromBody(body),
        fields: body.fields,
        source_file_id: body.source_file_id ?? null,
        metadata: body.metadata,
      });
      return NextResponse.json({ ok: true, claim });
    }
    const claim = await insertClaim({
      workspace_id: body.workspace_id,
      claim_type: body.claim_type,
      statement: body.statement,
      status: body.status,
      validated: body.validated,
      source_file_id: body.source_file_id,
      metadata: body.metadata,
    });
    return NextResponse.json({ ok: true, claim });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not insert claim";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

const patchSchema = z.object({
  workspace_id: z.string().min(1),
  claim_id: z.string().min(1),
  rationale: z.string(),
  patch: claimPatchSchema,
  ...actorFieldsSchema,
});

/**
 * PATCH /api/accuracy/claims — human edit / override of any claim field.
 * Rationale required (min 3 chars). Changed fields are human-locked and
 * recorded in metadata.edit_history; AI re-runs never overwrite them.
 */
export async function PATCH(request: Request) {
  try {
    const body = patchSchema.parse(await request.json());
    const result = await updateClaim({
      workspace_id: body.workspace_id,
      claim_id: body.claim_id,
      patch: body.patch,
      rationale: body.rationale,
      actor: actorFromBody(body),
    });

    let statuses: unknown = null;
    const statusFields = ["status_override", "tactic_status"];
    if (result.changed.some((field) => statusFields.includes(field))) {
      const org_id = await getWorkspaceOrgId(body.workspace_id);
      if (org_id) {
        const derived = await runAccuracyModule({
          call_kind: "status_derive",
          agent_role: "none",
          input: { workspace_id: body.workspace_id },
          actor: actorFromBody(body),
          org_id,
          workspace_id: body.workspace_id,
        });
        statuses = derived.output;
      }
    }
    return NextResponse.json({ ok: true, claim: result.claim, changed: result.changed, statuses });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update claim";
    const status = /^Unknown claim/.test(message) ? 404 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
