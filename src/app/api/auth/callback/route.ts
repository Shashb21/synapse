import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { afterSignIn, LOGIN_NEXT_COOKIE } from "@/modules/auth/redirect";
import { completeLogin, loginErrorCode, type LoginErrorCode } from "@/modules/auth/session";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";
import { recordAuditBestEffort } from "@/modules/kernel/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth redirect target for user sign-in. Success lands on the workspace
 * picker; a failure goes back to /login with the reason shown. A verified
 * email without a seat on an active customer gets no session and
 * `/login?error=no_seat` (KAN-28).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // /login is sent a code, never the provider's or the error's text (KAN-28).
  const failed = (reason: LoginErrorCode) => {
    const back = new URL("/login", url.origin);
    back.searchParams.set("error", reason);
    return NextResponse.redirect(back);
  };
  if (!code || !state) {
    const reason = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "The sign-in was cancelled.";
    await recordAuditBestEffort({
      category: "auth",
      action: "auth.login_failed",
      actor: { principal: "anonymous", name: "Anonymous", role: null },
      workspace_id: null,
      meta: { method: "sso", reason: "cancelled_or_refused_by_provider", detail: reason.slice(0, 300) },
    });
    return failed("cancelled");
  }
  try {
    await completeLogin({ code, state });
  } catch (error) {
    // No seat (none assigned, unassigned, or the customer deactivated) is a bare
    // code too, so /login shows one message and nothing about which part failed.
    // completeLogin has already put the detail in the audit log.
    return failed(loginErrorCode(error));
  }
  const jar = await cookies();
  const next = jar.get(LOGIN_NEXT_COOKIE)?.value;
  jar.delete(LOGIN_NEXT_COOKIE);
  await clearWorkspaceSelection();
  return NextResponse.redirect(new URL(afterSignIn(next), url.origin));
}
