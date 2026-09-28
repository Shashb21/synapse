import { NextResponse } from "next/server";
import { asActorFunction, AccountError } from "@/modules/auth/accounts";
import { afterSignIn, safeNext } from "@/modules/auth/redirect";
import { signUpWithPassword, signupAllowed, SIGNUP_CLOSED_MESSAGE } from "@/modules/auth/password-login";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self sign-up: `{ name, email, actor_function, password, confirm, next? }`.
 * The account is a contributor with an unverified email and is signed in at
 * once. Closed (403) when ALLOW_SIGNUP=0.
 */
export async function POST(request: Request) {
  if (!signupAllowed()) {
    return NextResponse.json({ error: SIGNUP_CLOSED_MESSAGE, code: "signup_closed" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const next = typeof body.next === "string" ? safeNext(body.next, "") : "";
  try {
    await signUpWithPassword({
      name: typeof body.name === "string" ? body.name : "",
      email: typeof body.email === "string" ? body.email : "",
      actor_function: asActorFunction(body.actor_function),
      password: typeof body.password === "string" ? body.password : "",
      confirm: typeof body.confirm === "string" ? body.confirm : undefined,
    });
    await clearWorkspaceSelection();
    return NextResponse.json({ ok: true, redirect: afterSignIn(next) });
  } catch (error) {
    if (error instanceof AccountError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "exists" ? 409 : 400 });
    }
    console.error("sign-up failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Sign-up failed. Try again." }, { status: 500 });
  }
}
