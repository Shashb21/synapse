import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { afterSignIn, LOGIN_NEXT_COOKIE } from "@/modules/auth/redirect";
import { completeLogin } from "@/modules/auth/session";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth redirect target for user sign-in. Success lands on the workspace
 * picker; a failure goes back to /login with the reason shown.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const failed = (reason: string) => {
    const back = new URL("/login", url.origin);
    back.searchParams.set("error", reason);
    return NextResponse.redirect(back);
  };
  if (!code || !state) {
    return failed(
      url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "The sign-in was cancelled.",
    );
  }
  try {
    await completeLogin({ code, state });
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Sign-in failed.");
  }
  const jar = await cookies();
  const next = jar.get(LOGIN_NEXT_COOKIE)?.value;
  jar.delete(LOGIN_NEXT_COOKIE);
  await clearWorkspaceSelection();
  return NextResponse.redirect(new URL(afterSignIn(next), url.origin));
}
