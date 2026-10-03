/** Authenticated, workspace-scoped inspection API for immutable extraction assemblies. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { AssemblyError } from "@/accuracy/domain/assembly";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import { listAssemblies, readAssembly } from "@/accuracy/store/assembly-store";
import { assemblyReviewState, reviewAssembly } from "@/accuracy/store/assembly-review-store";
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
      return NextResponse.json({ assembly, review_state, can_review: canReview(session.role) });
    }
    return NextResponse.json({ assemblies: await listAssemblies(workspace_id) });
  } catch (error) {
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
    const body = reviewBodySchema.parse(await request.json());
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
    if (error instanceof AssemblyReviewError) {
      const status = assemblyReviewStatus(error);
      return NextResponse.json({ error: status === 404 ? "Assembly not found" : error.message, code: error.code }, { status });
    }
    console.error("Could not review assembly", error);
    return NextResponse.json({ error: "Could not review assembly" }, { status: 500 });
  }
}
