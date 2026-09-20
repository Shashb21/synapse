export const CLAUDE_CODE_IDENTITY_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_CODE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_CODE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_CODE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const CLAUDE_CODE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const FINGERPRINT_SALT = "59cf53e54c78";
export const CLAUDE_CODE_DEFAULT_CLI_VERSION = "2.1.85";

export const CLAUDE_CODE_OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
] as const;

export type AgenticAuthMode = "oauth" | "none";

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
  source: "env" | "file" | "keychain" | "merged" | "dashboard";
  path?: string;
};

export type AgenticCallRecord = {
  id: string;
  at: string;
  auth_mode: "oauth";
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
  session_id?: string;
  oauth_source?: ClaudeCodeOAuthCredential["source"];
  system_chars?: number;
  user_chars?: number;
  system_preview?: string;
  user_preview?: string;
};

export type ReauthEvent = {
  id?: string;
  at?: string;
  type: "expiring" | "refreshed" | "refresh_failed" | "unauthorized";
  expiresAt?: number;
  error?: string;
  request_id?: string;
};

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
  expires_at: number | null;
  reauth_needed: boolean;
  source: ClaudeCodeOAuthCredential["source"] | null;
  has_refresh_token: boolean;
  token_hint: string | null;
  subscription_type: string | null;
  hint: string | null;
};
