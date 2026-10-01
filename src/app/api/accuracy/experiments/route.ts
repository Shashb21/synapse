/** Authenticated experiment start and source-workspace-scoped record export API. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { CALL_KINDS } from "@/accuracy/kernel/contracts";
import { mustFindForPack } from "@/accuracy/eval/reference-gold";
import { exportExperimentsForSourceWorkspace } from "@/accuracy/experiments/records";
import { runAccuracyExperiment } from "@/accuracy/experiments/run";
import { getSourceFile } from "@/accuracy/store/source-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const requestSchema = z.object({
  mode: z.enum(["single_call", "pipeline"]),
  source_workspace_id: z.string().trim().min(1),
  source_file_ids: z.array(z.string().trim().min(1)).min(1),
  pack_id: z.string().trim().min(1),
  condition: z.record(z.string(), z.unknown()),
  call: z.object({
    call_kind: z.enum(CALL_KINDS),
    input: z.record(z.string(), z.unknown()),
  }).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "single_call" && !value.call) {
    context.addIssue({ code: "custom", path: ["call"], message: "A single_call experiment requires a call." });
  }
  if (value.mode === "pipeline" && value.call) {
    context.addIssue({ code: "custom", path: ["call"], message: "A pipeline experiment does not accept a single call." });
  }
});

function unauthorized() {
  return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
}

async function authorizedSourceWorkspace(source_workspace_id: string, session: Awaited<ReturnType<typeof sessionContext>>) {
  if (!session.session) return null;
  return getAuthorizedWorkspace({ workspace_id: source_workspace_id, subject: session.session.subject, role: session.role });
}

function forbiddenRequestKey(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(forbiddenRequestKey).find((key): key is string => Boolean(key)) ?? null;
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (/(^|_)(gold|workspace_id|copied_workspace_id|copy_workspace_id)($|_)/i.test(key)) return key;
    const nested = forbiddenRequestKey(child);
    if (nested) return nested;
  }
  return null;
}

/** Export records for an original source workspace. */
export async function GET(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return unauthorized();
  const url = new URL(request.url);
  const source_workspace_id = url.searchParams.get("source_workspace_id")?.trim() ?? "";
  const format = url.searchParams.get("format") ?? "json";
  if (!source_workspace_id || (format !== "json" && format !== "jsonl")) {
    return NextResponse.json({ error: "source_workspace_id and format=json|jsonl are required" }, { status: 400 });
  }
  if (!await authorizedSourceWorkspace(source_workspace_id, session)) {
    return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
  }
  const exported = await exportExperimentsForSourceWorkspace({ source_workspace_id, format });
  if (format === "jsonl") {
    return new Response(exported, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }
  return new Response(exported, { headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Start a validated isolated experiment without trusting client actor, org, gold, or copy identifiers. */
export async function POST(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return unauthorized();
  if (!can(session.role, "validate")) {
    return NextResponse.json({ error: "You do not have validation capability" }, { status: 403 });
  }
  try {
    const body = requestSchema.parse(await request.json());
    if (!await authorizedSourceWorkspace(body.source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    mustFindForPack(body.pack_id);
    const forbiddenKey = forbiddenRequestKey({ condition: body.condition, input: body.call?.input });
    if (forbiddenKey) {
      return NextResponse.json({ error: `Request may not contain ${forbiddenKey}` }, { status: 400 });
    }
    const sources = await Promise.all(body.source_file_ids.map((source_file_id) => getSourceFile(body.source_workspace_id, source_file_id)));
    if (sources.some((source) => !source)) {
      return NextResponse.json({ error: "Every source_file_id must belong to the source workspace" }, { status: 400 });
    }
    const experiment = await runAccuracyExperiment({ ...body, actor: session.actor });
    return NextResponse.json({ experiment }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof Error && error.message.startsWith("Unknown reference pack"))) {
      return NextResponse.json({ error: error instanceof z.ZodError ? "Invalid experiment request" : "Unknown reference pack" }, { status: 400 });
    }
    console.error("Could not start isolated accuracy experiment", error);
    return NextResponse.json({ error: "Could not start experiment" }, { status: 500 });
  }
}
