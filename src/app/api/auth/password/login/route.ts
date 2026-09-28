import { NextResponse } from "next/server";
import { afterSignIn, safeNext } from "@/modules/auth/redirect";
import { PasswordLoginError, signInWithPassword } from "@/modules/auth/password-login";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<PasswordLoginError["code"], number> = { incorrect: 401, locked: 423, disabled: 403, domain: 403 };

/**
 * Email + password sign-in: `{ email, password, next? }`. Wrong password and
 * unknown email get the same 401 "Email or password is incorrect."; the fifth
 * failure in a row locks the account for 15 minutes (423).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const next = typeof body.next === "string" ? safeNext(body.next, "") : "";
  try {
    await signInWithPassword({
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : "",
    });
    // A new session never inherits the previous person's workspace.
    await clearWorkspaceSelection();
    return NextResponse.json({ ok: true, redirect: afterSignIn(next) });
  } catch (error) {
    if (error instanceof PasswordLoginError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
    }
    console.error("password sign-in failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Sign-in failed. Try again." }, { status: 500 });
  }
}
