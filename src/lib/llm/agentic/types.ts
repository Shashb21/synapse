export const CLAUDE_CODE_IDENTITY_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_CODE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const FINGERPRINT_SALT = "59cf53e54c78";
export const CLAUDE_CODE_DEFAULT_CLI_VERSION = "2.1.85";

export const CLAUDE_CODE_OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
] as const;

export type AgenticAuthMode = "oauth" | "api_key" | "none";

export type AgenticPurpose =
  | "proposer"
  | "critic"
  | "judge"
  | "improver"
  | "insight_extract"
  | "generic"
  | "validate";

export type ClaudeCodeOAuthCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  scopes?: string[];
  source: "env" | "file" | "keychain" | "merged";
  path?: string;
};

export type AgenticCallRecord = {
  id: string;
  at: string;
  auth_mode: Exclude<AgenticAuthMode, "none">;
  model: string;
  purpose: AgenticPurpose;
  ok: boolean;
  http_status?: number;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
  reauth?: "refreshed" | "failed" | "skipped" | "expiring";
  request_id?: string;
};

export type ReauthEvent =
  | { type: "expiring"; expiresAt?: number }
  | { type: "refreshed"; expiresAt?: number }
  | { type: "refresh_failed"; error: string }
  | { type: "unauthorized"; error: string };

export type ReauthHook = (event: ReauthEvent) => void | Promise<void>;

export type AgenticCompleteArgs = {
  system: string;
  user: string;
  maxTokens?: number;
  purpose?: AgenticPurpose;
};

export type AgenticAuthStatus = {
  ready: boolean;
  auth_mode: AgenticAuthMode;
  oauth: boolean;
  api_key: boolean;
  expires_at: number | null;
  reauth_needed: boolean;
  source: ClaudeCodeOAuthCredential["source"] | "api_key" | null;
  hint: string | null;
};
