import { NextResponse } from "next/server";
import { AccountError } from "@/modules/auth/accounts";
import { listAdminUsers, runAdminUserAction } from "@/modules/auth/admin-users";
import { ownerAccess, ownerGate } from "@/modules/auth/owner";
import { currentSession } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Email + password accounts, for the owner console's Users page. Owner only. */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  return NextResponse.json({ users: await listAdminUsers() });
}

/**
 * `{ action, ... }`: create (returns a temporary password once), reset_password
 * (likewise), set_role, set_admin, verify, set_disabled, unlock. Owner only; an
 * admin cannot demote, un-admin or disable themself.
 */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const access = await ownerAccess();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "The request body must be a JSON object.", code: "invalid_json" }, { status: 400 });
  }
  const session = await currentSession().catch(() => null);
  try {
    const result = await runAdminUserAction(body, {
      session,
      label: access.email ?? access.actor.name,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AccountError) {
      const status = error.code === "not_found" ? 404 : error.code === "exists" ? 409 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    console.error("admin users action failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "That did not work. Try again." }, { status: 500 });
  }
}
