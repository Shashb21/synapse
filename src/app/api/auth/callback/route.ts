import { NextResponse } from "next/server";
import { completeLogin } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth redirect target for user sign-in. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const back = new URL("/control", url.origin);
  if (!code || !state) {
    back.searchParams.set("sign_in_error", url.searchParams.get("error") ?? "missing code or state");
    return NextResponse.redirect(back);
  }
  try {
    const session = await completeLogin({ code, state });
    back.searchParams.set("signed_in", session.actor.name);
  } catch (error) {
    back.searchParams.set("sign_in_error", error instanceof Error ? error.message : "sign-in failed");
  }
  return NextResponse.redirect(back);
}
