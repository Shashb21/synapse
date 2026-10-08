import { AssemblyError } from "@/accuracy/domain/assembly";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Actor } from "@/accuracy/kernel/contracts";
import { DuplicateWorkspaceSlugError, getWorkspace } from "@/accuracy/store/tenant";
import { ownerAccess } from "@/modules/auth/owner";

/**
 * Shared request handling for accuracy API routes: malformed JSON is a 400
 * "Invalid JSON" (never a 500), validator errors read as one short line, an
 * unknown workspace is a 404 before anything is written, and every write is
 * credited to the signed-in owner, never to a name sent in the body.
 */

export class LabRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LabRequestError";
  }
}

export const UNKNOWN_WORKSPACE = "Unknown workspace";
const MAX_MESSAGE = 160;

/** The request body as JSON; a body that does not parse is a 400 "Invalid JSON". */
export async function readLabJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new LabRequestError(400, "Invalid JSON", "invalid_json");
  }
}

/** Reads and validates the body in one step. */
export async function parseLabBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  return schema.parse(await readLabJson(request));
}

/** A validator error as one readable line: the first issue's path and message. */
export function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.map(String).join(".");
  const line = path ? `${path}: ${issue.message}` : issue.message;
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
}

/** A user-facing message for any error a route catches. */
export function labErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) return validationMessage(error);
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** The lab workspace, or a 404 "Unknown workspace" before any write. */
export async function requireLabWorkspace(workspace_id: string) {
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new LabRequestError(404, UNKNOWN_WORKSPACE, "unknown_workspace");
  return workspace;
}

/** Who a lab write is credited to: the signed-in owner, resolved server-side. */
export async function labActor(): Promise<Actor> {
  return (await ownerAccess()).actor;
}

/**
 * The response for the errors every lab route shares (bad JSON, validator
 * errors, unknown workspace, duplicate slug), or null for the route to handle.
 */
export function labRequestErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AssemblyError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400 });
  if (error instanceof AssemblyReviewError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409 });
  if (error instanceof LabRequestError) {
    return NextResponse.json(
      { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status },
    );
  }
  if (error instanceof DuplicateWorkspaceSlugError) {
    return NextResponse.json({ ok: false, error: error.message, code: "duplicate_slug" }, { status: 409 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ ok: false, error: validationMessage(error) }, { status: 400 });
  }
  return null;
}

export async function labRevisionAuthor() {
  const { sessionContext } = await import("@/modules/auth/session");
  const context = await sessionContext();
  if (!context.signed_in || !context.session || context.role !== "contributor") return undefined;
  return { subject: context.session.subject, provider: context.session.provider_id, actor: context.actor, role: "contributor" as const };
}
