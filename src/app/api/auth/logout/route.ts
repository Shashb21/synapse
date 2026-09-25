import { NextResponse } from "next/server";
import { signOut } from "@/modules/auth/session";
import { clearWorkspaceSelection } from "@/modules/workspaces/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends the session and forgets the selected workspace. */
export async function POST() {
  await signOut();
  await clearWorkspaceSelection();
  return NextResponse.json({ ok: true, redirect: "/login" });
}
