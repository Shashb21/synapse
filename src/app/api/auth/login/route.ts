import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { afterSignIn, LOGIN_NEXT_COOKIE, safeNext } from "@/modules/auth/redirect";
import { beginLogin, signInDemo } from "@/modules/auth/session";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a sign-in. `{ provider_id }` returns the identity provider's authorize
 * URL (Google, Microsoft or GitHub); `{ demo: true, actor_name }` signs in as a
 * demo user, which only a non-production build accepts. Either way the person
 * then chooses a workspace.
 *
 * A demo body's `role` and `email` are requests, not grants: signInDemo honours
 * them only under the test stub (SYNAPSE_TEST_STUB_LLM=1); otherwise a demo user
 * is a contributor at `<name>@demo.synapse.local`.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const next = typeof body.next === "string" ? safeNext(body.next, "") : "";
  try {
    if (body.demo === true) {
      await signInDemo({
        actor_name: String(body.actor_name ?? ""),
        actor_function: String(body.actor_function ?? "medical_affairs") as never,
        email: typeof body.email === "string" ? body.email : null,
        role: typeof body.role === "string" ? (body.role as never) : undefined,
      });
      // A new session never inherits the previous person's workspace.
      await clearWorkspaceSelection();
      return NextResponse.json({ ok: true, redirect: afterSignIn(next) });
    }
    const provider_id = String(body.provider_id ?? "");
    if (!provider_id) throw new Error("Choose how to sign in.");
    const origin = new URL(request.url).origin;
    const { authorize_url } = await beginLogin({ provider_id, redirect_uri: `${origin}/api/auth/callback` });
    const jar = await cookies();
    if (next) {
      jar.set(LOGIN_NEXT_COOKIE, next, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
    } else {
      jar.delete(LOGIN_NEXT_COOKIE);
    }
    return NextResponse.json({ ok: true, authorize_url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sign-in failed." }, { status: 400 });
  }
}
