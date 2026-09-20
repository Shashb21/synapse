import { randomUUID } from "node:crypto";
import { anthropicApiKey, anthropicModel, anthropicWorkspaceId } from "@/lib/config";
import { extractJsonObject } from "../json";
import {
  ANTHROPIC_MESSAGES_URL,
  type AgenticAuthMode,
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
import { recordAgenticCall } from "./tracking";

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
  apiKey?: () => string | undefined;
  model?: () => string;
  workspaceId?: () => string | undefined;
  record?: (record: AgenticCallRecord) => Promise<void> | void;
};

let defaultHookRegistered = false;

function preferredAuthMode(): "oauth" | "api_key" | "auto" {
  const raw = process.env.AGENTIC_AUTH?.trim().toLowerCase();
  if (raw === "oauth" || raw === "api_key" || raw === "auto") return raw;
  return "auto";
}

function inferPurpose(system: string, explicit?: AgenticPurpose): AgenticPurpose {
  if (explicit) return explicit;
  if (system.includes("You are the critic")) return "critic";
  if (system.includes("You are the judge")) return "judge";
  if (system.includes("You are the improver")) return "improver";
  return "generic";
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
    const apiKey = this.deps.apiKey?.() ?? anthropicApiKey();
    const mode = this.resolveMode(cred, apiKey);
    const expiring = cred ? credentialExpiring(cred, this.now()) : false;
    const reauth_needed = mode === "oauth" && Boolean(cred && expiring && !cred.refreshToken);
    let hint: string | null = null;
    if (mode === "none") {
      hint =
        "Log in with Claude Code (`claude /login`) or set CLAUDE_CODE_OAUTH_TOKEN. ANTHROPIC_API_KEY still works as a fallback.";
    } else if (reauth_needed) {
      hint = "Claude Code OAuth token is expired. Run `claude /login` or set CLAUDE_CODE_REFRESH_TOKEN.";
    }
    return {
      ready: mode !== "none",
      auth_mode: mode,
      oauth: mode === "oauth",
      api_key: Boolean(apiKey),
      expires_at: cred?.expiresAt ?? null,
      reauth_needed,
      source: mode === "oauth" ? (cred?.source ?? null) : mode === "api_key" ? "api_key" : null,
      hint,
    };
  }

  async completeJson(args: AgenticCompleteArgs): Promise<unknown> {
    const purpose = inferPurpose(args.system, args.purpose);
    const started = this.now();
    const requestId = randomUUID();
    let auth: Exclude<AgenticAuthMode, "none"> | "none" = "none";
    let reauth: AgenticCallRecord["reauth"];
    let httpStatus: number | undefined;
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    try {
      const prepared = await this.prepareAuth();
      auth = prepared.mode;
      reauth = prepared.reauth;
      const attempt = await this.send(args, prepared, requestId);
      httpStatus = attempt.httpStatus;
      usage = attempt.usage;
      if (attempt.retry && prepared.mode === "oauth") {
        const retried = await this.refreshAndRetry(args, prepared.credential, requestId);
        reauth = retried.reauth;
        httpStatus = retried.httpStatus;
        usage = retried.usage;
        const json = extractJsonObject(retried.text);
        await this.track({
          purpose,
          started,
          auth_mode: "oauth",
          ok: true,
          http_status: httpStatus,
          usage,
          reauth,
          request_id: requestId,
        });
        return json;
      }
      if (!attempt.ok) {
        throw new Error(attempt.error);
      }
      const json = extractJsonObject(attempt.text);
      await this.track({
        purpose,
        started,
        auth_mode: prepared.mode,
        ok: true,
        http_status: httpStatus,
        usage,
        reauth,
        request_id: requestId,
      });
      return json;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agentic call failed";
      await this.track({
        purpose,
        started,
        auth_mode: auth === "none" ? "api_key" : auth,
        ok: false,
        http_status: httpStatus,
        usage,
        reauth: reauth === "failed" ? "failed" : reauth,
        request_id: requestId,
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

  private resolveMode(
    cred: ClaudeCodeOAuthCredential | null,
    apiKey: string | undefined,
  ): AgenticAuthMode {
    const pref = preferredAuthMode();
    if (pref === "oauth") return cred ? "oauth" : "none";
    if (pref === "api_key") return apiKey ? "api_key" : "none";
    if (cred) return "oauth";
    if (apiKey) return "api_key";
    return "none";
  }

  private async prepareAuth(): Promise<{
    mode: Exclude<AgenticAuthMode, "none">;
    credential: ClaudeCodeOAuthCredential | null;
    apiKey?: string;
    reauth?: AgenticCallRecord["reauth"];
  }> {
    let cred = this.credential ?? this.deps.loadCredential?.() ?? loadClaudeCodeCredential();
    const apiKey = this.deps.apiKey?.() ?? anthropicApiKey();
    const mode = this.resolveMode(cred, apiKey);
    if (mode === "none") {
      throw new Error(
        "No Claude Code OAuth session or ANTHROPIC_API_KEY. Gap extraction needs a live LLM (proposer, critic, judge). Run `claude /login` or set CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    let reauth: AgenticCallRecord["reauth"];
    if (mode === "oauth" && cred && credentialExpiring(cred, this.now())) {
      await emitReauth({ type: "expiring", expiresAt: cred.expiresAt });
      reauth = "expiring";
      try {
        cred = await (this.deps.refresh ?? refreshClaudeCodeCredential)(cred);
        this.credential = cred;
        reauth = "refreshed";
        await emitReauth({ type: "refreshed", expiresAt: cred.expiresAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : "OAuth refresh failed";
        await emitReauth({ type: "refresh_failed", error: message });
        if (!cred.refreshToken || credentialExpiring(cred, this.now(), 0)) {
          throw new Error(message);
        }
        reauth = "failed";
      }
    }
    this.credential = cred;
    if (mode === "oauth" && !cred) {
      throw new Error("Claude Code OAuth was selected but no credential was loaded.");
    }
    return { mode, credential: cred, apiKey, reauth };
  }

  private async send(
    args: AgenticCompleteArgs,
    prepared: {
      mode: Exclude<AgenticAuthMode, "none">;
      credential: ClaudeCodeOAuthCredential | null;
      apiKey?: string;
    },
    requestId: string,
  ): Promise<{
    ok: boolean;
    retry: boolean;
    text: string;
    error: string;
    httpStatus: number;
    usage?: { input_tokens?: number; output_tokens?: number };
  }> {
    const model = this.deps.model?.() ?? anthropicModel();
    const headers: Record<string, string> =
      prepared.mode === "oauth" && prepared.credential
        ? oauthRequestHeaders(prepared.credential.accessToken, requestId, this.sessionId)
        : {
            "content-type": "application/json",
            "x-api-key": prepared.apiKey ?? "",
            "anthropic-version": "2023-06-01",
          };
    if (prepared.mode === "api_key") {
      const workspace = this.deps.workspaceId?.() ?? anthropicWorkspaceId();
      if (workspace) headers["anthropic-workspace-id"] = workspace;
    }
    const body =
      prepared.mode === "oauth"
        ? {
            model,
            max_tokens: args.maxTokens ?? 8192,
            temperature: 0,
            system: oauthSystemBlocks({ system: args.system, user: args.user }),
            messages: [{ role: "user", content: args.user }],
          }
        : {
            model,
            max_tokens: args.maxTokens ?? 8192,
            temperature: 0,
            system: args.system,
            messages: [{ role: "user", content: args.user }],
          };
    const res = await this.fetchImpl()(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as AnthropicMessage;
    const usage = payload.usage;
    if (!res.ok) {
      const message = payload.error?.message ?? `Anthropic HTTP ${res.status}`;
      const unauthorized = res.status === 401 || /unauthor/i.test(message);
      if (prepared.mode === "oauth" && unauthorized) {
        await emitReauth({ type: "unauthorized", error: message });
        return { ok: false, retry: true, text: "", error: message, httpStatus: res.status, usage };
      }
      if (
        prepared.mode === "api_key" &&
        /workspace-id|not scoped to a workspace/i.test(message) &&
        !(this.deps.workspaceId?.() ?? anthropicWorkspaceId())
      ) {
        throw new Error(
          "ANTHROPIC_WORKSPACE_ID is not set. This Anthropic API key is identity-linked and needs anthropic-workspace-id on every request (Claude Console → Settings → Workspaces, wrkspc_…).",
        );
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
    credential: ClaudeCodeOAuthCredential | null,
    requestId: string,
  ) {
    if (!credential) {
      throw new Error("Claude Code OAuth returned 401 and no credential is available to refresh.");
    }
    try {
      const refreshed = await (this.deps.refresh ?? refreshClaudeCodeCredential)(credential);
      this.credential = refreshed;
      await emitReauth({ type: "refreshed", expiresAt: refreshed.expiresAt });
      const attempt = await this.send(
        args,
        { mode: "oauth", credential: refreshed },
        requestId,
      );
      if (!attempt.ok) throw new Error(attempt.error);
      return { ...attempt, reauth: "refreshed" as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth refresh failed";
      await emitReauth({ type: "refresh_failed", error: message });
      throw new Error(message);
    }
  }

  private async track(args: {
    purpose: AgenticPurpose;
    started: number;
    auth_mode: Exclude<AgenticAuthMode, "none">;
    ok: boolean;
    http_status?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
    reauth?: AgenticCallRecord["reauth"];
    request_id: string;
    error?: string;
  }) {
    const record: AgenticCallRecord = {
      id: `LLM-${randomUUID().slice(0, 8)}`,
      at: new Date(this.now()).toISOString(),
      auth_mode: args.auth_mode,
      model: this.deps.model?.() ?? anthropicModel(),
      purpose: args.purpose,
      ok: args.ok,
      http_status: args.http_status,
      latency_ms: Math.max(0, this.now() - args.started),
      input_tokens: args.usage?.input_tokens,
      output_tokens: args.usage?.output_tokens,
      error: args.error,
      reauth: args.reauth,
      request_id: args.request_id,
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
  return agenticAuthStatus().ready;
}
