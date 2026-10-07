import { NextResponse } from "next/server";
import { AccountError } from "@/modules/auth/accounts";
import { changeOwnPassword } from "@/modules/auth/password-login";
import { currentSession } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Changes the signed-in person's password: `{ current, next, confirm? }`. The current one must be right. */
export async function POST(request: Request) {
  const session = await currentSession().catch(() => null);
  if (!session) return NextResponse.json({ error: "Sign in first.", code: "no_session" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    await changeOwnPassword({
      session,
      current: typeof body.current === "string" ? body.current : "",
      next: typeof body.next === "string" ? body.next : "",
      confirm: typeof body.confirm === "string" ? body.confirm : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("password change failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not change your password." }, { status: 500 });
  }
}
