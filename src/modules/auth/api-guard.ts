import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ACTOR_FUNCTIONS, type ActorFunction } from "@/lib/iegp/enums";
import type { Actor } from "@/modules/kernel/contracts";
import { AI_OFF_MESSAGE, AiDisabledError } from "@/modules/kernel/ai-switch";
import { NoWorkspaceError, selectedWorkspaceId } from "@/modules/workspaces/context";
import { principalOf } from "@/modules/workspaces/session";
import { getWorkspace, memberRole, type WorkspaceWithRole } from "@/modules/workspaces/store";
import { currentSession, SESSION_COOKIE, type Session } from "./session";
import { can, ForbiddenError, ROLE_LABELS, type Capability, type Role } from "./roles";

/**
 * The one server-side check every customer API runs (REQ-AUTH-004/005/006,
 * REQ-WS-005). The proxy only looks for cookies; this verifies them:
 *
 * 1. the session cookie names a live, unexpired `auth_sessions` row (sign-out
 *    deletes the row, so access ends at once) — else 401 `no_session`;
 * 2. a workspace is selected and its cookie verifies against this session —
 *    else 409 `no_workspace` (the same code the proxy uses);
 * 3. the signed-in person is still a member of that workspace — else 403
 *    `not_member` (removing someone ends their access on the next request);
 * 4. optionally, their role holds the capability — else 403 `forbidden`.
 *
 * The actor it returns is the signed-in person. Request bodies never name the
 * actor for a signed-in user.
 *
 * Test-only path: Vitest calls route handlers directly with no request cookies
 * and names the actor in the body. That is honoured only when all of these
 * hold: not a production build, SYNAPSE_TEST_STUB_LLM=1, SYNAPSE_TEST_ANON_API=1
 * (set in vitest.config.ts only; the Playwright dev server does not set it),
 * and the request carries no session cookie at all. The context is then the
 * demo Medical Affairs role in whatever workspace the query scope resolves to.
 */

export type GuardCode = "no_session" | "no_workspace" | "not_member" | "forbidden" | "invalid_json";

export class ApiGuardError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409,
    readonly code: GuardCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiGuardError";
  }
}

export type CustomerContext = {
  /** Null only on the Vitest anonymous path. */
  session: Session | null;
  /** Who the person is for membership and per-person records. */
  principal: string;
  actor: Actor;
  role: Role;
  /** The verified selected workspace; null only on the Vitest anonymous path. */
  workspace: WorkspaceWithRole | null;
  anonymous_test: boolean;
};

export type GuardOptions = {
  capability?: Capability;
  /** Only read on the Vitest anonymous path, for the typed actor. */
  body?: Record<string, unknown>;
  /** Default true: the route reads or writes workspace data. */
  workspace?: boolean;
};

/** True only under Vitest with the explicit opt-in; never in a production build. */
export function testAnonymousApiAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.SYNAPSE_TEST_STUB_LLM === "1" && env.SYNAPSE_TEST_ANON_API === "1";
}

async function hasSessionCookie(): Promise<boolean> {
  try {
    return Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  } catch {
    return false; // not inside a request (a unit test calling a handler directly)
  }
}

function testActor(body?: Record<string, unknown>): Actor {
  const name = typeof body?.actor_name === "string" ? body.actor_name.trim() : "";
  const fn = typeof body?.actor_function === "string" ? body.actor_function.trim() : "";
  return {
    name: name || "Test user",
    function: ACTOR_FUNCTIONS.includes(fn as ActorFunction) ? (fn as ActorFunction) : "medical_affairs",
  };
}

/** Throws 403 `forbidden` unless the role holds the capability. */
export function requireCapability(context: Pick<CustomerContext, "role">, capability: Capability): void {
  if (!can(context.role, capability)) {
    throw new ApiGuardError(403, "forbidden", `${ROLE_LABELS[context.role]} may not ${capability.replace(/_/g, " ")}.`);
  }
}

export async function requireCustomerContext(options: GuardOptions = {}): Promise<CustomerContext> {
  const needsWorkspace = options.workspace !== false;
  if (testAnonymousApiAllowed() && !(await hasSessionCookie())) {
    const context: CustomerContext = {
      session: null,
      principal: `guest:${testActor(options.body).name}`,
      actor: testActor(options.body),
      role: "medical_affairs",
      workspace: null,
      anonymous_test: true,
    };
    if (options.capability) requireCapability(context, options.capability);
    return context;
  }

  let session: Session | null = null;
  try {
    session = await currentSession();
  } catch {
    session = null;
  }
  if (!session) throw new ApiGuardError(401, "no_session", "Sign in first.");
  const principal = principalOf(session);

  let workspace: WorkspaceWithRole | null = null;
  if (needsWorkspace) {
    const id = await selectedWorkspaceId();
    if (!id) throw new ApiGuardError(409, "no_workspace", "Choose a workspace first.");
    const [found, membership] = await Promise.all([getWorkspace(id), memberRole(id, principal)]);
    if (!found) throw new ApiGuardError(409, "no_workspace", "That workspace no longer exists. Choose another.");
    if (!membership) throw new ApiGuardError(403, "not_member", "You are not a member of this workspace.");
    workspace = { ...found, role: membership };
  }

  const context: CustomerContext = {
    session,
    principal,
    actor: session.actor,
    role: session.role,
    workspace,
    anonymous_test: false,
  };
  if (options.capability) requireCapability(context, options.capability);
  return context;
}

/** The JSON body as an object; malformed JSON is a 400, never a 500. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiGuardError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiGuardError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Guard and role failures keep their status (401/403/409), AI-off is 409, and
 * anything else is a 400 with its message.
 */
export function apiErrorResponse(error: unknown, fallback = "Request failed"): NextResponse {
  if (error instanceof ApiGuardError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: error.message, code: "forbidden" }, { status: 403 });
  }
  if (error instanceof NoWorkspaceError) {
    return NextResponse.json({ error: error.message, code: "no_workspace" }, { status: 409 });
  }
  if (error instanceof AiDisabledError) {
    return NextResponse.json({ error: error.message || AI_OFF_MESSAGE, code: "ai_off" }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: message }, { status: 400 });
}
