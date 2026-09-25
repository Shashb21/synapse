import { NextResponse, type NextRequest } from "next/server";
import { gateFor, PRESENT_HEADER, PROXY_SESSION_COOKIE, PROXY_WORKSPACE_COOKIE } from "@/modules/auth/gate";

/** Customer routes need a session and a workspace; see modules/auth/gate.ts for the rules. */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const gate = gateFor(pathname);
  if (gate === "open") return NextResponse.next();

  const api = pathname.startsWith("/api/");
  const hasSession = Boolean(request.cookies.get(PROXY_SESSION_COOKIE)?.value);
  const next = `${pathname}${search}`;

  if (!hasSession) {
    if (api) return NextResponse.json({ error: "Sign in first.", code: "no_session" }, { status: 401 });
    const url = new URL("/login", request.url);
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }
  if (gate === "workspace" && !request.cookies.get(PROXY_WORKSPACE_COOKIE)?.value) {
    if (api) {
      return NextResponse.json({ error: "Choose a workspace first.", code: "no_workspace" }, { status: 409 });
    }
    const url = new URL("/workspaces", request.url);
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }
  return withPresentHeader(request);
}

/**
 * Room frames real pages with `?present=1`; the app shells read this header
 * (server-side, no search params needed) and render without their chrome.
 */
function withPresentHeader(request: NextRequest) {
  const headers = new Headers(request.headers);
  if (request.nextUrl.searchParams.get("present") === "1") headers.set(PRESENT_HEADER, "1");
  else headers.delete(PRESENT_HEADER);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
