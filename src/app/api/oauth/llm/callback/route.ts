import { NextResponse } from "next/server";
import { completeOauth } from "@/modules/llm/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth redirect target for LLM provider connections made in the control panel. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const back = new URL("/control", url.origin);

  if (error) {
    back.searchParams.set("connect_error", error);
    return NextResponse.redirect(back);
  }
  if (!code || !state) {
    back.searchParams.set("connect_error", "missing code or state");
    return NextResponse.redirect(back);
  }
  try {
    const connection = await completeOauth({ provider_id: provider, code, state });
    back.searchParams.set("connected", connection.provider_id);
  } catch (failure) {
    back.searchParams.set(
      "connect_error",
      failure instanceof Error ? failure.message : "connection failed",
    );
  }
  return NextResponse.redirect(back);
}
