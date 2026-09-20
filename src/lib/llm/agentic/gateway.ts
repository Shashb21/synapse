import { randomUUID } from "node:crypto";
import { anthropicModel } from "@/lib/config";
import { estimateCostUsd, moduleForPurpose } from "@/lib/llm/catalog";
import { getLlmSettings } from "@/lib/llm/settings";
import { extractJsonObject } from "../json";
import {
  ANTHROPIC_MESSAGES_URL,
  type AgenticAuthStatus,
  type AgenticCallRecord,
  type AgenticCompleteArgs,
  type AgenticPurpose,
  type ClaudeCodeOAuthCredential,
} from "./types";
import {
  credentialExpiring,
  loadClaudeCodeCredential,
  oauthRequestHeaders,
  oauthSystemBlocks,
  refreshClaudeCodeCredential,
} from "./oauth";
import { defaultReauthLogHook, emitReauth, registerReauthHook } from "./reauth";
import { previewText, recordAgenticCall } from "./tracking";

type AnthropicMessage = {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
};

export type AgenticGatewayDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  loadCredential?: () => ClaudeCodeOAuthCredential | null;
  refresh?: (credential: ClaudeCodeOAuthCredential) => Promise<ClaudeCodeOAuthCredential>;
  model?: () => string;
  record?: (record: AgenticCallRecord) => Promise<void> | void;
};

let defaultHookRegistered = false;

const OAUTH_REQUIRED =
  "No Claude Code OAuth session. Live LLM calls require `claude /login` or CLAUDE_CODE_OAUTH_TOKEN. API keys are not used.";

function inferPurpose(system: string, explicit?: AgenticPurpose): AgenticPurpose {
  if (explicit) return explicit;
  if (system.includes("You are the critic")) return "critic";
  if (system.includes("You are the judge")) return "judge";
  if (system.includes("You are the improver")) return "improver";
  return "generic";
}

function tokenHint(token: string): string {
  const prefix = token.slice(0, Math.min(12, token.length));
  return `${prefix}… (${token.length} chars)`;
}

export class AgenticGateway {
  private sessionId = randomUUID();
  private credential: ClaudeCodeOAuthCredential | null = null;

  constructor(private readonly deps: AgenticGatewayDeps = {}) {
    if (
      !defaultHookRegistered &&
      process.env.VITEST !== "true" &&
      process.env.AGENTIC_REAUTH_LOG !== "0"
    ) {
      registerReauthHook(defaultReauthLogHook);
      defaultHookRegistered = true;
    }
  }

  resetSession() {
    this.sessionId = randomUUID();
    this.credential = null;
  }

  authStatus(): AgenticAuthStatus {
    const cred = this.deps.loadCredential?.() ?? loadClaudeCodeCredential();
    const expiring = cred ? credentialExpiring(cred, this.now()) : false;
    const reauth_needed = Boolean(cred && expiring && !cred.refreshToken);
    return {
      ready: Boolean(cred),
      auth_mode: cred ? "oauth" : "none",
      oauth: Boolean(cred),
      expires_at: cred?.expiresAt ?? null,
      reauth_needed,
      source: cred?.source ?? null,
      has_refresh_token: Boolean(cred?.refreshToken),
      token_hint: cred ? tokenHint(cred.accessToken) : null,
      subscription_type: cred?.subscriptionType ?? null,
      hint: cred
        ? reauth_needed
          ? "Claude Code OAuth token is expired. Run `claude /login` or set CLAUDE_CODE_REFRESH_TOKEN."
          : null
        : OAUTH_REQUIRED,
    };
  }

  async completeJson(args: AgenticCompleteArgs): Promise<unknown> {
    const purpose = inferPurpose(args.system, args.purpose);
    const started = this.now();
    const requestId = randomUUID();
    let cred: ClaudeCodeOAuthCredential | null = null;
    let reauth: AgenticCallRecord["reauth"];
    let httpStatus: number | undefined;
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    try {
      const prepared = await this.prepareAuth(requestId);
      cred = prepared.credential;
      reauth = prepared.reauth;
      const attempt = await this.send(args, prepared.credential, requestId);
      httpStatus = attempt.httpStatus;
      usage = attempt.usage;
      if (attempt.retry) {
        const retried = await this.refreshAndRetry(args, prepared.credential, requestId);
        reauth = retried.reauth;
        httpStatus = retried.httpStatus;
        usage = retried.usage;
        cred = this.credential;
        const json = extractJsonObject(retried.text);
        await this.track({
          args,
          purpose,
          started,
          ok: true,
          http_status: httpStatus,
          usage,
          reauth,
          request_id: requestId,
          credential: cred,
        });
        return json;
      }
      if (!attempt.ok) {
        throw new Error(attempt.error);
      }
      const json = extractJsonObject(attempt.text);
      await this.track({
        args,
        purpose,
        started,
        ok: true,
        http_status: httpStatus,
        usage,
        reauth,
        request_id: requestId,
        credential: prepared.credential,
      });
      return json;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agentic call failed";
      await this.track({
        args,
        purpose,
        started,
        ok: false,
        http_status: httpStatus,
        usage,
        reauth: reauth === "failed" ? "failed" : reauth,
        request_id: requestId,
        credential: cred ?? this.credential,
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private fetchImpl() {
    return this.deps.fetch ?? fetch;
  }

  private async prepareAuth(requestId: string): Promise<{
    credential: ClaudeCodeOAuthCredential;
    reauth?: AgenticCallRecord["reauth"];
  }> {
    let cred = this.credential ?? this.deps.loadCredential?.() ?? loadClaudeCodeCredential();
    if (!cred) {
      throw new Error(OAUTH_REQUIRED);
    }
    let reauth: AgenticCallRecord["reauth"];
    if (credentialExpiring(cred, this.now())) {
      await emitReauth({ type: "expiring", expiresAt: cred.expiresAt, request_id: requestId });
      reauth = "expiring";
      try {
        cred = await (this.deps.refresh ?? refreshClaudeCodeCredential)(cred);
        this.credential = cred;
        reauth = "refreshed";
        await emitReauth({ type: "refreshed", expiresAt: cred.expiresAt, request_id: requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "OAuth refresh failed";
        await emitReauth({ type: "refresh_failed", error: message, request_id: requestId });
        if (!cred.refreshToken || credentialExpiring(cred, this.now(), 0)) {
          throw new Error(message);
        }
        reauth = "failed";
      }
    }
    this.credential = cred;
    return { credential: cred, reauth };
  }

  private async send(
    args: AgenticCompleteArgs,
    credential: ClaudeCodeOAuthCredential,
    requestId: string,
  ): Promise<{
    ok: boolean;
    retry: boolean;
    text: string;
    error: string;
    httpStatus: number;
    usage?: { input_tokens?: number; output_tokens?: number };
  }> {
    const model = this.resolveModel(args);
    const headers = oauthRequestHeaders(credential.accessToken, requestId, this.sessionId);
    const res = await this.fetchImpl()(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: args.maxTokens ?? 8192,
        temperature: 0,
        system: oauthSystemBlocks({ system: args.system, user: args.user }),
        messages: [{ role: "user", content: args.user }],
      }),
    });
    const payload = (await res.json()) as AnthropicMessage;
    const usage = payload.usage;
    if (!res.ok) {
      const message = payload.error?.message ?? `Anthropic HTTP ${res.status}`;
      const unauthorized = res.status === 401 || /unauthor/i.test(message);
      if (unauthorized) {
        await emitReauth({ type: "unauthorized", error: message, request_id: requestId });
        return { ok: false, retry: true, text: "", error: message, httpStatus: res.status, usage };
      }
      return { ok: false, retry: false, text: "", error: message, httpStatus: res.status, usage };
    }
    const text = (payload.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { ok: true, retry: false, text, error: "", httpStatus: res.status, usage };
  }

  private async refreshAndRetry(
    args: AgenticCompleteArgs,
    credential: ClaudeCodeOAuthCredential,
    requestId: string,
  ) {
    try {
      const refreshed = await (this.deps.refresh ?? refreshClaudeCodeCredential)(credential);
      this.credential = refreshed;
      await emitReauth({ type: "refreshed", expiresAt: refreshed.expiresAt, request_id: requestId });
      const attempt = await this.send(args, refreshed, requestId);
      if (!attempt.ok) throw new Error(attempt.error);
      return { ...attempt, reauth: "refreshed" as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth refresh failed";
      await emitReauth({ type: "refresh_failed", error: message, request_id: requestId });
      throw new Error(message);
    }
  }

  private resolveModel(args: AgenticCompleteArgs): string {
    return args.model?.trim() || this.deps.model?.() || anthropicModel();
  }

  private async track(args: {
    args: AgenticCompleteArgs;
    purpose: AgenticPurpose;
    started: number;
    ok: boolean;
    http_status?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
    reauth?: AgenticCallRecord["reauth"];
    request_id: string;
    credential: ClaudeCodeOAuthCredential | null;
    error?: string;
  }) {
    const model = this.resolveModel(args.args);
    const module = args.args.module || moduleForPurpose(args.purpose);
    const cost_usd = estimateCostUsd(
      model,
      args.usage?.input_tokens,
      args.usage?.output_tokens,
      getLlmSettings().costs,
    );
    const record: AgenticCallRecord = {
      id: `LLM-${randomUUID().slice(0, 8)}`,
      at: new Date(this.now()).toISOString(),
      auth_mode: "oauth",
      provider: "claude_code",
      module,
      model,
      purpose: args.purpose,
      ok: args.ok,
      http_status: args.http_status,
      latency_ms: Math.max(0, this.now() - args.started),
      input_tokens: args.usage?.input_tokens,
      output_tokens: args.usage?.output_tokens,
      cost_usd,
      error: args.error,
      reauth: args.reauth,
      request_id: args.request_id,
      session_id: this.sessionId,
      oauth_source: args.credential?.source,
      system_chars: args.args.system.length,
      user_chars: args.args.user.length,
      system_preview: previewText(args.args.system),
      user_preview: previewText(args.args.user),
    };
    await (this.deps.record ?? recordAgenticCall)(record);
  }
}

export const agenticGateway = new AgenticGateway();

export function completeJson(args: AgenticCompleteArgs): Promise<unknown> {
  return agenticGateway.completeJson(args);
}

export function agenticAuthStatus(): AgenticAuthStatus {
  return agenticGateway.authStatus();
}

export function hasClaudeCodeOAuth(): boolean {
  return Boolean(loadClaudeCodeCredential());
}

export function hasAgenticLlm(): boolean {
  return hasClaudeCodeOAuth();
}
