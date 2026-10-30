import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody } from "@/modules/auth/api-guard";
import { AccountError } from "@/modules/auth/accounts";
import { changeOwnPassword } from "@/modules/auth/password-login";
import { currentSession } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Changes the signed-in person's password: `{ current, next, confirm? }`. The current one must be right. */
export async function POST(request: Request) {
  const session = await currentSession().catch(() => null);
  if (!session) return NextResponse.json({ safe_error: true, error: "Sign in first.", code: "no_session" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return apiErrorResponse(error);
  }
  try {
    await changeOwnPassword({
      session,
      current: typeof body.current === "string" ? body.current : "",
      next: typeof body.next === "string" ? body.next : "",
      confirm: typeof body.confirm === "string" ? body.confirm : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountError) return NextResponse.json({ safe_error: true, error: error.message }, { status: 400 });
    console.error("password change failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ safe_error: true, error: "We couldn’t confirm the password change. Check whether you can sign in with the new password before changing it again. If neither password works, contact your Synapse administrator." }, { status: 500 });
  }
}
