import { NextResponse } from "next/server";
import { completeJson } from "@/lib/llm/router";
import {
  completeClaudeCodeLogin,
  logoutClaudeCodeSession,
  savePastedClaudeCodeSession,
  startClaudeCodeLogin,
} from "@/lib/llm/agentic/login";
import { loadClaudeCodeCredential, refreshClaudeCodeCredential } from "@/lib/llm/agentic/oauth";
import { agenticAuthStatus, agenticGateway } from "@/lib/llm/agentic";
import { isLlmProviderId, type LlmProviderId } from "@/lib/llm/catalog";
import {
  completeOpenRouterLogin,
  logoutProvider,
  pollGrokLogin,
  saveProviderPaste,
  startGrokLogin,
  startOpenRouterLogin,
} from "@/lib/llm/providers/oauth-login";
import { allProviderSnapshots, providerAuthSnapshot } from "@/lib/llm/ready";

export const runtime = "nodejs";

function parseProvider(body: Record<string, unknown>): LlmProviderId {
  return isLlmProviderId(body.provider) ? body.provider : "claude_code";
}

function authPayload(provider: LlmProviderId) {
  return {
    auth: provider === "claude_code" ? agenticAuthStatus() : providerAuthSnapshot(provider),
    providers: allProviderSnapshots(),
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "").trim();
  const provider = parseProvider(body);
  try {
    if (action === "start") {
      if (provider === "openrouter") {
        const started = startOpenRouterLogin();
        return NextResponse.json({
          ok: true,
          provider,
          authorize_url: started.authorize_url,
          instructions:
            "Approve OpenRouter in the new tab, then paste the one-time code from the callback page.",
          ...authPayload(provider),
        });
      }
      if (provider === "grok") {
        const started = await startGrokLogin();
        return NextResponse.json({
          ok: true,
          provider,
          user_code: started.user_code,
          verification_uri: started.verification_uri,
          verification_uri_complete: started.verification_uri_complete,
          interval: started.interval,
          expires_in: started.expires_in,
          instructions: `Open ${started.verification_uri} and enter code ${started.user_code}, then click Poll.`,
          ...authPayload(provider),
        });
      }
      const started = startClaudeCodeLogin();
      return NextResponse.json({
        ok: true,
        provider,
        authorize_url: started.authorize_url,
        instructions:
          "Open the URL, approve Claude Code, then paste the code#state string from the callback page.",
        ...authPayload(provider),
      });
    }
    if (action === "complete") {
      const paste = String(body.code ?? body.paste ?? "").trim();
      if (provider === "openrouter") {
        await completeOpenRouterLogin(paste);
        return NextResponse.json({ ok: true, provider, ...authPayload(provider) });
      }
      if (provider !== "claude_code") {
        return NextResponse.json({ error: "Use poll or save for this provider." }, { status: 400 });
      }
      const result = await completeClaudeCodeLogin(paste);
      return NextResponse.json({ ok: true, provider, auth: result.auth, providers: allProviderSnapshots() });
    }
    if (action === "poll") {
      if (provider !== "grok") {
        return NextResponse.json({ error: "Poll is only used for Grok device OAuth." }, { status: 400 });
      }
      const result = await pollGrokLogin();
      return NextResponse.json({
        ok: true,
        provider,
        pending: result.pending,
        ...authPayload(provider),
      });
    }
    if (action === "save") {
      if (provider === "claude_code") {
        const result = savePastedClaudeCodeSession({
          access_token: typeof body.access_token === "string" ? body.access_token : undefined,
          refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
          credentials_json:
            typeof body.credentials_json === "string" ? body.credentials_json : undefined,
        });
        return NextResponse.json({
          ok: true,
          provider,
          auth: result.auth,
          providers: allProviderSnapshots(),
        });
      }
      saveProviderPaste(provider, {
        access_token: typeof body.access_token === "string" ? body.access_token : undefined,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      });
      return NextResponse.json({ ok: true, provider, ...authPayload(provider) });
    }
    if (action === "refresh") {
      if (provider !== "claude_code") {
        return NextResponse.json({ error: "Refresh is only implemented for Claude Code." }, { status: 400 });
      }
      const cred = loadClaudeCodeCredential();
      if (!cred) throw new Error("No Claude Code session to refresh.");
      const next = await refreshClaudeCodeCredential(cred);
      agenticGateway.resetSession();
      return NextResponse.json({
        ok: true,
        provider,
        auth: agenticAuthStatus(),
        providers: allProviderSnapshots(),
        expires_at: next.expiresAt ?? null,
      });
    }
    if (action === "logout") {
      if (provider === "claude_code") {
        const result = logoutClaudeCodeSession();
        return NextResponse.json({
          ok: true,
          provider,
          auth: result.auth,
          providers: allProviderSnapshots(),
        });
      }
      logoutProvider(provider);
      return NextResponse.json({ ok: true, provider, ...authPayload(provider) });
    }
    if (action === "ping") {
      const json = await completeJson({
        system: 'Reply with JSON only: {"pong":true,"auth":"oauth"}.',
        user: "Ping from the observability dashboard.",
        maxTokens: 64,
        purpose: "validate",
        provider,
      });
      return NextResponse.json({ ok: true, provider, json, ...authPayload(provider) });
    }
    return NextResponse.json({ error: "Unknown OAuth action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth action failed";
    return NextResponse.json({ error: message, provider, ...authPayload(provider) }, { status: 400 });
  }
}
