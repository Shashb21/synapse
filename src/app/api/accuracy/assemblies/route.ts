import { SplitError } from "@/accuracy/store/partial-split-store";
/** Authenticated, workspace-scoped inspection API for immutable extraction assemblies. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { assemblyRevisionChangeSchema } from "@/accuracy/domain/assembly-revision";
import { createAssemblyRevision, retryAssemblyRevision } from "@/accuracy/kernel/assembly-revision";
import { assemblyRevisionState } from "@/accuracy/store/assembly-revision-store";
import { AssemblyError } from "@/accuracy/domain/assembly";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import { ASSEMBLY_FEEDBACK_CATEGORIES, AssemblyFeedbackError } from "@/accuracy/domain/assembly-feedback";
import { readParseBlocks } from "@/accuracy/store/parse-store";
import { listAssemblies, readAssembly } from "@/accuracy/store/assembly-store";
import { assemblyReviewState, reviewAssembly } from "@/accuracy/store/assembly-review-store";
import { createAssemblyFeedback, listAssemblyFeedback, listAssemblyFeedbackRuns } from "@/accuracy/store/assembly-feedback-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { sessionContext } from "@/modules/auth/session";
import type { Role } from "@/modules/auth/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badQuery(query: URLSearchParams): boolean {
  const allowed = new Set(["workspace_id", "assembly_id"]);
  const workspace_id = query.get("workspace_id")?.trim() ?? "";
  const assembly_id = query.get("assembly_id")?.trim();
  return !workspace_id
    || query.getAll("workspace_id").length !== 1
    || query.getAll("assembly_id").length > 1
    || (query.has("assembly_id") && !assembly_id)
    || [...query.keys()].some((key) => !allowed.has(key));
}

const reviewBodySchema = z.object({
  workspace_id: z.string().min(1),
  assembly_id: z.string().min(1),
  expected_fingerprint: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  rationale: z.string().min(1),
  advisory_overrides: z.array(z.object({
    code: z.string().min(1),
    item_version_ids: z.array(z.string()),
    reason: z.string().min(1),
  }).strict()).default([]),
  expected_review_id: z.string().min(1).nullable().optional(),
}).strict();

const revisionBodySchema = z.object({
  action: z.literal("revise"), workspace_id: z.string().trim().min(1),
  parent_assembly_id: z.string().trim().min(1), expected_fingerprint: z.string().min(1),
  expected_head_id: z.string().min(1), change: assemblyRevisionChangeSchema,
}).strict();
const retryBodySchema = z.object({
  action: z.literal("retry_revision"), workspace_id: z.string().trim().min(1),
  assembly_id: z.string().trim().min(1), expected_fingerprint: z.string().min(1), expected_head_id: z.string().min(1),
}).strict();
const feedbackBodySchema = z.object({
  action: z.literal("feedback"),
  workspace_id: z.string().trim().min(1),
  assembly_id: z.string().trim().min(1),
  expected_fingerprint: z.string().trim().min(1),
  approval_review_id: z.string().trim().min(1),
  consumer_run_id: z.string().trim().min(1),
  selected_item_version_ids: z.array(z.string().trim().min(1)).optional(),
  category: z.enum(ASSEMBLY_FEEDBACK_CATEGORIES),
  rationale: z.string().trim().min(1),
}).strict();

function canReview(role: Role): boolean {
  return role === "medical_affairs" || role === "contributor";
}

function assemblyReviewStatus(error: AssemblyReviewError): number {
  if (error.code === "invalid_input") return 400;
  if (error.code === "not_found") return 404;
  if (error.code === "forbidden") return 403;
  return 409;
}

/** List assemblies for a workspace, or read one assembly when assembly_id is supplied. */
export async function GET(request: Request) {
  try {
    const session = await sessionContext();
    if (!session.signed_in) return NextResponse.json({ error: "Sign in to access assemblies" }, { status: 401 });
    const query = new URL(request.url).searchParams;
    if (badQuery(query)) return NextResponse.json({ error: "Supply one workspace_id and optionally one assembly_id" }, { status: 400 });
    const workspace_id = query.get("workspace_id")!.trim();
    const assembly_id = query.get("assembly_id")?.trim() ?? "";
    if (!session.session || !await getAuthorizedWorkspace({ workspace_id, subject: session.session.subject, role: session.role })) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (assembly_id) {
      const assembly = await readAssembly(workspace_id, assembly_id);
      if (!assembly) return NextResponse.json({ error: "Assembly not found" }, { status: 404 });
      const review_state = await assemblyReviewState(workspace_id, assembly_id);
      const revision_state = await assemblyRevisionState(workspace_id, assembly_id);
      const [feedback, feedback_runs] = await Promise.all([
        listAssemblyFeedback(workspace_id, assembly_id),
        listAssemblyFeedbackRuns(workspace_id, assembly_id),
      ]);
      const evidence_blocks = (await Promise.all(assembly.source_file_ids.map(source_id => readParseBlocks(workspace_id, source_id))))
        .flat().map(block => ({ id: block.id, source_file_id: block.source_file_id, text: block.text }));
      return NextResponse.json({ assembly, review_state, revision_state, evidence_blocks, feedback, feedback_runs,
        can_review: canReview(session.role), can_feedback: session.role === "contributor",
        can_revise: session.role === "contributor" && review_state.head_status === "current" && assembly.linking_complete,
        can_retry_revision: session.role === "contributor" && review_state.head_status === "current" && revision_state.can_retry });
    }
    const assemblies = await listAssemblies(workspace_id);
    const revision_states = Object.fromEntries(await Promise.all(assemblies.map(async assembly =>
      [assembly.id, await assemblyRevisionState(workspace_id, assembly.id)] as const)));
    return NextResponse.json({ assemblies, revision_states });
  } catch (error) {
    if (error instanceof AssemblyFeedbackError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    if (error instanceof SplitError) return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    if (error instanceof AssemblyReviewError) {
      const status = assemblyReviewStatus(error);
      return NextResponse.json({ error: status === 404 ? "Assembly not found" : status === 403 ? "Forbidden" : status === 400 ? "Invalid assembly review request" : "Assembly review conflict" }, { status });
    }
    if (error instanceof AssemblyError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: status === 404 ? "Assembly not found" : status === 409 ? "Assembly conflict" : "Invalid assembly request" }, { status });
    }
    console.error("Could not read assemblies", error);
    return NextResponse.json({ error: "Could not read assemblies" }, { status: 500 });
  }
}

/** Decide the exact current assembly for an authorized workspace. */
export async function POST(request: Request) {
  try {
    const session = await sessionContext();
    if (!session.signed_in || !session.session) return NextResponse.json({ error: "Sign in to review assemblies" }, { status: 401 });
    if (!canReview(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const raw: unknown = await request.json();
    const action = raw && typeof raw === "object" ? (raw as Record<string, unknown>).action : undefined;
    if (action === "feedback") {
      if (session.role !== "contributor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      const body = feedbackBodySchema.parse(raw);
      if (!await getAuthorizedWorkspace({ workspace_id: body.workspace_id, subject: session.session.subject, role: session.role })) {
        return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      }
      const feedback = await createAssemblyFeedback({
        workspace_id: body.workspace_id, assembly_id: body.assembly_id,
        expected_fingerprint: body.expected_fingerprint, approval_review_id: body.approval_review_id,
        consumer_run_id: body.consumer_run_id, selected_item_version_ids: body.selected_item_version_ids,
        category: body.category, rationale: body.rationale,
        contributor: { subject: session.session.subject, provider: session.session.provider_id, actor: session.session.actor },
      });
      return NextResponse.json({ ok: true, feedback });
    }
    if (action === "revise" || action === "retry_revision") {
      if (session.role !== "contributor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      const author = { subject: session.session.subject, provider: session.session.provider_id, actor: session.actor, role: "contributor" as const };
      if (action === "revise") {
        const body = revisionBodySchema.parse(raw);
        const workspace = await getAuthorizedWorkspace({ workspace_id: body.workspace_id, subject: session.session.subject, role: session.role });
        if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
        const result = await createAssemblyRevision({ ...body, org_id: workspace.org_id, author });
        const revision_state = await assemblyRevisionState(body.workspace_id, result.assembly.id);
        return NextResponse.json({ ok: true, ...result, revision_state });
      }
      const body = retryBodySchema.parse(raw);
      const workspace = await getAuthorizedWorkspace({ workspace_id: body.workspace_id, subject: session.session.subject, role: session.role });
      if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      const result = await retryAssemblyRevision({ ...body, org_id: workspace.org_id, author });
      const revision_state = await assemblyRevisionState(body.workspace_id, result.assembly.id);
      return NextResponse.json({ ok: true, ...result, revision_state });
    }
    const body = reviewBodySchema.parse(raw);
    if (!await getAuthorizedWorkspace({ workspace_id: body.workspace_id, subject: session.session.subject, role: session.role })) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    const review = await reviewAssembly({
      workspace_id: body.workspace_id,
      assembly_id: body.assembly_id,
      expected_fingerprint: body.expected_fingerprint,
      expected_review_id: body.expected_review_id ?? null,
      decision: body.decision,
      rationale: body.rationale,
      advisory_overrides: body.advisory_overrides,
      reviewer: {
        subject: session.session.subject,
        provider: session.session.provider_id,
        actor: session.actor,
        role: session.role,
      },
    });
    const state = await assemblyReviewState(body.workspace_id, body.assembly_id);
    return NextResponse.json({ ok: true, review, state });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues.map(issue => issue.message).join("; ") }, { status: 400 });
    if (error instanceof AssemblyFeedbackError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    if (error instanceof SplitError) return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    if (error instanceof AssemblyReviewError) {
      const status = assemblyReviewStatus(error);
      return NextResponse.json({ error: status === 404 ? "Assembly not found" : error.message, code: error.code }, { status });
    }
    if (error instanceof AssemblyError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: status === 404 ? "Assembly not found" : error.message, code: error.code }, { status });
    }
    console.error("Could not review assembly", error);
    return NextResponse.json({ error: "Could not review assembly" }, { status: 500 });
  }
}
