/** Read current/historical extraction findings and record authorized contributor decisions. */
import { and, eq } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import { accuracyExtractionBatches } from "@/accuracy/store/schema";
import { extractionBatchForRun } from "@/accuracy/store/extraction-batch-store";
import { NextResponse } from "next/server";
import { assertCan, ForbiddenError } from "@/modules/auth/roles";
import { requestIdentity } from "@/modules/auth/request";
import { applyOmissionAction, getOmissionReviewsForRun, listCurrentOmissionReviews, listOmissionActionHistory,
  omissionActionInputSchema, OmissionActionError } from "@/accuracy/store/omission-review-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Return a bounded error response while keeping unexpected failures observable. */
function errorResponse(error: unknown) {
  if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
  if (error instanceof OmissionActionError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  console.error("Omission action request failed", error);
  return NextResponse.json({ error: "Unable to process omission review." }, { status: 500 });
}

/** Read current review items, or one historical run and its immutable action history. */
export async function GET(request: Request) {
  try {
    const identity = await requestIdentity();
    if (!identity.signed_in && !identity.demo) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const url = new URL(request.url);
    const workspace_id = url.searchParams.get("workspace_id")?.trim();
    const run_id = url.searchParams.get("run_id")?.trim();
    if (!workspace_id) return NextResponse.json({ error: "workspace_id is required." }, { status: 400 });
    if (run_id) {
      const reviews = await getOmissionReviewsForRun({ workspace_id, run_id });
      if (!reviews) return NextResponse.json({ error: "Unknown applied run in workspace." }, { status: 404 });
      const actions = await listOmissionActionHistory({ workspace_id, run_id });
      const extraction_batch_id = await extractionBatchForRun(workspace_id, run_id);
      const batch = extraction_batch_id ? (await accuracyDb().select({ source_file_id: accuracyExtractionBatches.source_file_id })
        .from(accuracyExtractionBatches).where(and(eq(accuracyExtractionBatches.workspace_id, workspace_id),
          eq(accuracyExtractionBatches.id, extraction_batch_id))).limit(1))[0] : null;
      return NextResponse.json({ ...reviews, actions, extraction_batch_id, source_file_id: batch?.source_file_id ?? null });
    }
    return NextResponse.json({ items: await listCurrentOmissionReviews(workspace_id) });
  } catch (error) { return errorResponse(error); }
}

/** Apply one action using the session actor and validate capability. */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
    const identity = await requestIdentity(body as Record<string, unknown>);
    if (!identity.signed_in && !identity.demo) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    assertCan(identity.role, "validate");
    const parsed = omissionActionInputSchema.safeParse({ ...body, actor: identity.actor });
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const action = await applyOmissionAction(parsed.data);
    return NextResponse.json({ ok: true, action, claim_id: action.claim_id });
  } catch (error) { return errorResponse(error); }
}
