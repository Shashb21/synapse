import { NextResponse } from "next/server";
import { afterOwnerSignIn, afterSignIn, safeNext } from "@/modules/auth/redirect";
import { isAdminAccount } from "@/modules/auth/accounts";
import { PasswordLoginError, signInWithPassword } from "@/modules/auth/password-login";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<PasswordLoginError["code"], number> = { incorrect: 401, locked: 423, disabled: 403, domain: 403, not_staff: 403 };

/**
 * Email + password sign-in for Synapse staff: `{ email, password, next? }`. Wrong password and
 * unknown email get the same 401 "Email or password is incorrect."; the fifth
 * failure in a row locks the account for 15 minutes (423).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const next = typeof body.next === "string" ? safeNext(body.next, "") : "";
  try {
    const session = await signInWithPassword({
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : "",
    });
    // A new session never inherits the previous person's workspace. Staff land on
    // the admin console (KAN-58); a test customer (KAN-59) on the workspace picker.
    await clearWorkspaceSelection();
    const staff = session.role === "operator" || (await isAdminAccount(session.subject));
    return NextResponse.json({ ok: true, redirect: staff ? afterOwnerSignIn(next) : afterSignIn(next) });
  } catch (error) {
    if (error instanceof PasswordLoginError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
    }
    console.error("password sign-in failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Sign-in failed. Try again." }, { status: 500 });
  }
}
