import { NextResponse } from "next/server";
import { completeJson } from "@/lib/llm/agentic";
import {
  completeClaudeCodeLogin,
  logoutClaudeCodeSession,
  savePastedClaudeCodeSession,
  startClaudeCodeLogin,
} from "@/lib/llm/agentic/login";
import { loadClaudeCodeCredential, refreshClaudeCodeCredential } from "@/lib/llm/agentic/oauth";
import { agenticAuthStatus, agenticGateway } from "@/lib/llm/agentic";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "").trim();
  try {
    if (action === "start") {
      const started = startClaudeCodeLogin();
      return NextResponse.json({
        ok: true,
        authorize_url: started.authorize_url,
        instructions:
          "Open the URL, approve Claude Code, then paste the code#state string from the callback page.",
      });
    }
    if (action === "complete") {
      const paste = String(body.code ?? body.paste ?? "").trim();
      const result = await completeClaudeCodeLogin(paste);
      return NextResponse.json({ ok: true, auth: result.auth });
    }
    if (action === "save") {
      const result = savePastedClaudeCodeSession({
        access_token: typeof body.access_token === "string" ? body.access_token : undefined,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        credentials_json:
          typeof body.credentials_json === "string" ? body.credentials_json : undefined,
      });
      return NextResponse.json({ ok: true, auth: result.auth });
    }
    if (action === "refresh") {
      const cred = loadClaudeCodeCredential();
      if (!cred) throw new Error("No Claude Code session to refresh.");
      const next = await refreshClaudeCodeCredential(cred);
      agenticGateway.resetSession();
      return NextResponse.json({ ok: true, auth: agenticAuthStatus(), expires_at: next.expiresAt ?? null });
    }
    if (action === "logout") {
      const result = logoutClaudeCodeSession();
      return NextResponse.json({ ok: true, auth: result.auth });
    }
    if (action === "ping") {
      const json = await completeJson({
        system: 'Reply with JSON only: {"pong":true,"auth":"oauth"}.',
        user: "Ping from the observability dashboard.",
        maxTokens: 64,
        purpose: "validate",
      });
      return NextResponse.json({ ok: true, json, auth: agenticAuthStatus() });
    }
    return NextResponse.json({ error: "Unknown OAuth action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth action failed";
    return NextResponse.json({ error: message, auth: agenticAuthStatus() }, { status: 400 });
  }
}
