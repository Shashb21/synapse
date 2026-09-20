"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgenticAuthStatus, AgenticCallRecord, ReauthEvent } from "@/lib/llm/agentic";
import type { LlmCostRate, LlmModuleId, LlmProviderId, LlmSettings } from "@/lib/llm/catalog";

type ExtractStep = {
  id: string;
  round: number;
  role: string;
  started_at: string;
  ended_at: string | null;
  latency_ms: number | null;
  error: string | null;
  request: unknown;
  response: unknown;
};

type ExtractRun = {
  id: string;
  kind: string;
  status: string;
  title: string;
  created_at: string;
  completed_at: string | null;
  persist: boolean;
  prompt_version: string;
  error: string | null;
  actor_name: string;
  actor_function: string;
  steps: ExtractStep[];
};

type ProviderSnap = {
  provider: LlmProviderId;
  ready: boolean;
  source: string | null;
  token_hint: string | null;
  expires_at: number | null;
  has_refresh_token: boolean;
  hint: string | null;
};

type Catalog = {
  providers: LlmProviderId[];
  modules: LlmModuleId[];
  provider_labels: Record<LlmProviderId, string>;
  module_labels: Record<LlmModuleId, string>;
  default_models: Record<LlmProviderId, string>;
  default_costs: Record<string, LlmCostRate>;
};

type Payload = {
  ok: boolean;
  at: string;
  model: string;
  auth: AgenticAuthStatus;
  settings?: LlmSettings;
  providers?: Record<LlmProviderId, ProviderSnap>;
  catalog?: Catalog;
  summary: {
    total: number;
    ok: number;
    failed: number;
    oauth: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd?: number;
    latency_ms_p50: number;
    latency_ms_p95: number;
    by_purpose: Record<string, number>;
    last: AgenticCallRecord | null;
  };
  calls: AgenticCallRecord[];
  reauth: ReauthEvent[];
  extract: ExtractRun[];
};

function fmtTime(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function fmtExpiry(ms: number | null) {
  if (!ms) return "—";
  const delta = ms - Date.now();
  if (delta <= 0) return `expired ${fmtTime(new Date(ms).toISOString())}`;
  const mins = Math.round(delta / 60000);
  return `${mins} min · ${fmtTime(new Date(ms).toISOString())}`;
}

function fmtCost(value?: number) {
  if (value == null || Number.isNaN(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[16px] font-medium text-foreground">{value}</p>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border border-border bg-background p-2 text-[11px] leading-4 text-muted-foreground">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

type OauthJson = {
  ok?: boolean;
  error?: string;
  authorize_url?: string;
  instructions?: string;
  json?: unknown;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  pending?: boolean;
};

async function postOauth(action: string, extra: Record<string, string> = {}) {
  const res = await fetch("/api/llm/oauth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const json = (await res.json()) as OauthJson;
  if (!res.ok) throw new Error(json.error ?? "OAuth action failed");
  return json;
}

function ClaudeLoginCard({
  auth,
  onChanged,
}: {
  auth: AgenticAuthStatus | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [credentialsJson, setCredentialsJson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(action: string, extra: Record<string, string> = {}) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const json = await postOauth(action, { provider: "claude_code", ...extra });
      if (json.authorize_url) {
        setAuthorizeUrl(json.authorize_url);
        window.open(json.authorize_url, "_blank", "noopener,noreferrer");
        setMessage(json.instructions ?? "Approve in the new tab, then paste code#state here.");
      } else if (action === "ping") {
        setMessage(`Test call ok: ${JSON.stringify(json.json)}`);
      } else if (action === "logout") {
        setPaste("");
        setAccessToken("");
        setRefreshToken("");
        setCredentialsJson("");
        setAuthorizeUrl(null);
        setMessage("Claude Code session cleared on this pod.");
      } else {
        setMessage("Claude Code OAuth is saved on this pod.");
        setPaste("");
        setAccessToken("");
        setRefreshToken("");
        setCredentialsJson("");
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-border bg-card p-4">
      <h2 className="text-[13px] font-medium">Claude Code login</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Connect this pod with your Claude Code account. Browser login pastes a{" "}
        <code className="text-foreground">code#state</code> string. You can also paste an OAuth
        access token from <code className="text-foreground">claude setup-token</code> or a{" "}
        <code className="text-foreground">.credentials.json</code> blob. Tokens stay on this
        machine and are not shown back.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy)} onClick={() => void post("start")}>
          {busy === "start" ? "Starting…" : "Start Claude login"}
        </Button>
        {auth?.ready ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy) || !auth.has_refresh_token}
              onClick={() => void post("refresh")}
            >
              {busy === "refresh" ? "Refreshing…" : "Refresh session"}
            </Button>
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void post("ping")}>
              {busy === "ping" ? "Pinging…" : "Test call"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() => void post("logout")}
            >
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
      {authorizeUrl ? (
        <p className="mt-2 break-all text-[11px] text-muted-foreground">
          If the tab did not open:{" "}
          <a className="text-foreground underline" href={authorizeUrl} target="_blank" rel="noreferrer">
            {authorizeUrl}
          </a>
        </p>
      ) : null}
      <label className="mt-3 grid gap-1 text-[11px] text-muted-foreground">
        Paste callback <code className="text-foreground">code#state</code>
        <textarea
          className="min-h-16 border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="AbCdEf#1234abcd…"
        />
      </label>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={Boolean(busy) || !paste.trim()}
        onClick={() => void post("complete", { code: paste })}
      >
        {busy === "complete" ? "Exchanging…" : "Finish login"}
      </Button>
      <p className="mt-4 text-[11px] text-muted-foreground">Or paste tokens / credentials JSON</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Access token
          <input
            className="h-8 border border-border bg-background px-2 font-mono text-[12px] text-foreground"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="sk-ant-oat…"
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Refresh token (optional)
          <input
            className="h-8 border border-border bg-background px-2 font-mono text-[12px] text-foreground"
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <label className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
        credentials.json
        <textarea
          className="min-h-20 border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground"
          value={credentialsJson}
          onChange={(e) => setCredentialsJson(e.target.value)}
          placeholder='{"claudeAiOauth":{"accessToken":"sk-ant-oat…","refreshToken":"…"}}'
        />
      </label>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={Boolean(busy) || (!accessToken.trim() && !credentialsJson.trim())}
        onClick={() =>
          void post("save", {
            access_token: accessToken,
            refresh_token: refreshToken,
            credentials_json: credentialsJson,
          })
        }
      >
        {busy === "save" ? "Saving…" : "Save OAuth session"}
      </Button>
      {message ? <p className="mt-2 text-[12px] text-foreground">{message}</p> : null}
      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
    </section>
  );
}

function GrokLoginCard({
  snap,
  onChanged,
}: {
  snap: ProviderSnap | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");

  async function post(action: string, extra: Record<string, string> = {}) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const json = await postOauth(action, { provider: "grok", ...extra });
      if (json.user_code) {
        setUserCode(json.user_code);
        setVerifyUrl(json.verification_uri_complete || json.verification_uri || null);
        if (json.verification_uri_complete || json.verification_uri) {
          window.open(json.verification_uri_complete || json.verification_uri, "_blank", "noopener,noreferrer");
        }
        setMessage(json.instructions ?? `Enter ${json.user_code} at the xAI device page, then poll.`);
      } else if (action === "poll" && json.pending) {
        setMessage("Still waiting for Grok device approval…");
      } else if (action === "ping") {
        setMessage(`Test call ok: ${JSON.stringify(json.json)}`);
      } else if (action === "logout") {
        setUserCode(null);
        setVerifyUrl(null);
        setAccessToken("");
        setRefreshToken("");
        setMessage("Grok session cleared on this pod.");
      } else {
        setMessage("Grok OAuth is saved on this pod.");
        setAccessToken("");
        setRefreshToken("");
        setUserCode(null);
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-border bg-card p-4">
      <h2 className="text-[13px] font-medium">Grok (xAI) login</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Device OAuth: start login, approve on xAI, then poll. You can also paste a Grok/xAI OAuth
        token. Tokens stay on this machine and are not shown back.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy)} onClick={() => void post("start")}>
          {busy === "start" ? "Starting…" : "Start Grok login"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={Boolean(busy) || !userCode}
          onClick={() => void post("poll")}
        >
          {busy === "poll" ? "Polling…" : "Poll device login"}
        </Button>
        {snap?.ready ? (
          <>
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void post("ping")}>
              {busy === "ping" ? "Pinging…" : "Test call"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() => void post("logout")}
            >
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
      {userCode ? (
        <p className="mt-2 text-[12px] text-foreground">
          Device code: <code className="font-mono">{userCode}</code>
          {verifyUrl ? (
            <>
              {" "}
              ·{" "}
              <a className="underline" href={verifyUrl} target="_blank" rel="noreferrer">
                {verifyUrl}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="mt-4 text-[11px] text-muted-foreground">Or paste an OAuth access token</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Access token
          <input
            className="h-8 border border-border bg-background px-2 font-mono text-[12px] text-foreground"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Refresh token (optional)
          <input
            className="h-8 border border-border bg-background px-2 font-mono text-[12px] text-foreground"
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={Boolean(busy) || !accessToken.trim()}
        onClick={() => void post("save", { access_token: accessToken, refresh_token: refreshToken })}
      >
        {busy === "save" ? "Saving…" : "Save Grok token"}
      </Button>
      {message ? <p className="mt-2 text-[12px] text-foreground">{message}</p> : null}
      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
    </section>
  );
}

function OpenRouterLoginCard({
  snap,
  onChanged,
}: {
  snap: ProviderSnap | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [accessToken, setAccessToken] = useState("");

  async function post(action: string, extra: Record<string, string> = {}) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const json = await postOauth(action, { provider: "openrouter", ...extra });
      if (json.authorize_url) {
        setAuthorizeUrl(json.authorize_url);
        window.open(json.authorize_url, "_blank", "noopener,noreferrer");
        setMessage(json.instructions ?? "Approve OpenRouter, then paste the one-time code.");
      } else if (action === "ping") {
        setMessage(`Test call ok: ${JSON.stringify(json.json)}`);
      } else if (action === "logout") {
        setPaste("");
        setAccessToken("");
        setAuthorizeUrl(null);
        setMessage("OpenRouter session cleared on this pod.");
      } else {
        setMessage("OpenRouter is saved on this pod.");
        setPaste("");
        setAccessToken("");
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-border bg-card p-4">
      <h2 className="text-[13px] font-medium">OpenRouter login</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        PKCE login creates a user-controlled API key. You can also paste an existing OpenRouter key.
        Keys stay on this machine and are not shown back.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy)} onClick={() => void post("start")}>
          {busy === "start" ? "Starting…" : "Start OpenRouter login"}
        </Button>
        {snap?.ready ? (
          <>
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void post("ping")}>
              {busy === "ping" ? "Pinging…" : "Test call"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() => void post("logout")}
            >
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
      {authorizeUrl ? (
        <p className="mt-2 break-all text-[11px] text-muted-foreground">
          If the tab did not open:{" "}
          <a className="text-foreground underline" href={authorizeUrl} target="_blank" rel="noreferrer">
            {authorizeUrl}
          </a>
        </p>
      ) : null}
      <label className="mt-3 grid gap-1 text-[11px] text-muted-foreground">
        Paste one-time code
        <textarea
          className="min-h-16 border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="OpenRouter callback code"
        />
      </label>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={Boolean(busy) || !paste.trim()}
        onClick={() => void post("complete", { code: paste })}
      >
        {busy === "complete" ? "Exchanging…" : "Finish login"}
      </Button>
      <p className="mt-4 text-[11px] text-muted-foreground">Or paste an OpenRouter key</p>
      <label className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
        API key
        <input
          className="h-8 border border-border bg-background px-2 font-mono text-[12px] text-foreground"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder="sk-or-…"
          autoComplete="off"
        />
      </label>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={Boolean(busy) || !accessToken.trim()}
        onClick={() => void post("save", { access_token: accessToken })}
      >
        {busy === "save" ? "Saving…" : "Save OpenRouter key"}
      </Button>
      {message ? <p className="mt-2 text-[12px] text-foreground">{message}</p> : null}
      {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
    </section>
  );
}

function RoutingAndCosts({
  settings,
  catalog,
  onSaved,
}: {
  settings: LlmSettings | undefined;
  catalog: Catalog | undefined;
  onSaved: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<LlmSettings | null>(settings ?? null);
  const [dirty, setDirty] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty && settings) setDraft(settings);
  }, [settings, dirty]);

  const modules = catalog?.modules ?? [];
  const providers = catalog?.providers ?? [];

  function updateRoute(moduleId: LlmModuleId, patch: { provider?: LlmProviderId; model?: string }) {
    if (!draft) return;
    const current = draft.routes[moduleId];
    const provider = patch.provider ?? current.provider;
    const model =
      patch.model ??
      (patch.provider ? catalog?.default_models[patch.provider] || current.model : current.model);
    setDraft({
      ...draft,
      routes: { ...draft.routes, [moduleId]: { provider, model } },
    });
    setDirty(true);
  }

  function updateCost(model: string, field: "input_per_mtok" | "output_per_mtok", value: string) {
    if (!draft) return;
    const n = Number(value);
    const prev = draft.costs[model] ?? { input_per_mtok: 0, output_per_mtok: 0, currency: "USD" as const };
    setDraft({
      ...draft,
      costs: { ...draft.costs, [model]: { ...prev, [field]: Number.isFinite(n) ? n : 0 } },
    });
    setDirty(true);
  }

  async function save() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/llm/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routes: draft.routes,
          costs: draft.costs,
          provider_defaults: draft.provider_defaults,
        }),
      });
      const json = (await res.json()) as { error?: string; settings?: LlmSettings };
      if (!res.ok) throw new Error(json.error ?? "Could not save settings");
      if (json.settings) setDraft(json.settings);
      setDirty(false);
      setMessage("Routing and costs saved.");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/llm/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const json = (await res.json()) as { error?: string; settings?: LlmSettings };
      if (!res.ok) throw new Error(json.error ?? "Could not reset settings");
      if (json.settings) setDraft(json.settings);
      setDirty(false);
      setMessage("Settings reset to defaults.");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset settings");
    } finally {
      setBusy(null);
    }
  }

  if (!draft || !catalog) {
    return (
      <section className="grid gap-4">
        <div className="border border-border bg-card p-4">
          <h2 className="text-[13px] font-medium">Module routing</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Loading routing and cost config…
          </p>
        </div>
        <div className="border border-border bg-card p-4">
          <h2 className="text-[13px] font-medium">Cost rates (USD / million tokens)</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">Loading cost rates…</p>
        </div>
      </section>
    );
  }

  return (
    <section className="grid gap-4">
      <div className="border border-border bg-card p-4">
        <h2 className="text-[13px] font-medium">Module routing</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Choose which LLM handles each API/module. A module fails if that provider is not logged in —
          there is no silent fallback.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Module</th>
                <th className="py-2 pr-3 font-medium">Provider</th>
                <th className="py-2 font-medium">Model</th>
              </tr>
            </thead>
            <tbody>
              {modules.map((moduleId) => (
                <tr key={moduleId} className="border-t border-border">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{moduleId}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {catalog.module_labels[moduleId]}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      className="h-8 border border-border bg-background px-2 text-[12px] text-foreground"
                      value={draft.routes[moduleId].provider}
                      onChange={(e) =>
                        updateRoute(moduleId, { provider: e.target.value as LlmProviderId })
                      }
                    >
                      {providers.map((id) => (
                        <option key={id} value={id}>
                          {catalog.provider_labels[id]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2">
                    <input
                      className="h-8 w-full min-w-[180px] border border-border bg-background px-2 font-mono text-[12px] text-foreground"
                      value={draft.routes[moduleId].model}
                      onChange={(e) => updateRoute(moduleId, { model: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border border-border bg-card p-4">
        <h2 className="text-[13px] font-medium">Cost rates (USD / million tokens)</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Used to estimate cost on the call log. Rates are per model name as sent to the provider.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 font-medium">Input</th>
                <th className="py-2 font-medium">Output</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(draft.costs)
                .sort()
                .map((model) => (
                  <tr key={model} className="border-t border-border">
                    <td className="py-2 pr-3 font-mono text-[11px]">{model}</td>
                    <td className="py-2 pr-3">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="h-8 w-24 border border-border bg-background px-2 text-[12px] text-foreground"
                        value={draft.costs[model]?.input_per_mtok ?? 0}
                        onChange={(e) => updateCost(model, "input_per_mtok", e.target.value)}
                      />
                    </td>
                    <td className="py-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="h-8 w-24 border border-border bg-background px-2 text-[12px] text-foreground"
                        value={draft.costs[model]?.output_per_mtok ?? 0}
                        onChange={(e) => updateCost(model, "output_per_mtok", e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Add model
            <input
              className="h-8 border border-border bg-background px-2 font-mono text-[12px] text-foreground"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="provider/model"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!newModel.trim()}
            onClick={() => {
              const name = newModel.trim();
              if (!name || !draft) return;
              setDraft({
                ...draft,
                costs: {
                  ...draft.costs,
                  [name]: draft.costs[name] ?? { input_per_mtok: 0, output_per_mtok: 0, currency: "USD" },
                },
              });
              setNewModel("");
              setDirty(true);
            }}
          >
            Add rate
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy) || !dirty} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : "Save config"}
        </Button>
        <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void reset()}>
          {busy === "reset" ? "Resetting…" : "Reset defaults"}
        </Button>
        {dirty ? <p className="self-center text-[12px] text-muted-foreground">Unsaved changes</p> : null}
      </div>
      {message ? <p className="text-[12px] text-foreground">{message}</p> : null}
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
    </section>
  );
}

export function ObservabilityDashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("all");
  const [outcome, setOutcome] = useState<"all" | "ok" | "fail">("all");
  const [query, setQuery] = useState("");
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/llm/observability?limit=400");
      const json = (await res.json()) as Payload & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load observability");
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load observability");
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);

  const calls = useMemo(() => {
    const rows = [...(data?.calls ?? [])].reverse();
    return rows.filter((row) => {
      if (purpose !== "all" && row.purpose !== purpose) return false;
      if (outcome === "ok" && !row.ok) return false;
      if (outcome === "fail" && row.ok) return false;
      if (query.trim()) {
        const hay =
          `${row.id} ${row.purpose} ${row.provider ?? ""} ${row.module ?? ""} ${row.model} ${row.error ?? ""} ${row.system_preview ?? ""} ${row.user_preview ?? ""} ${row.request_id ?? ""}`.toLowerCase();
        if (!hay.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [data?.calls, purpose, outcome, query]);

  const purposes = Object.keys(data?.summary.by_purpose ?? {}).sort();
  const providers = data?.providers;

  return (
    <div className="grid gap-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Claude Code" value={providers ? String(providers.claude_code.ready) : data ? String(data.auth.ready) : "…"} />
        <Metric label="Grok" value={providers ? String(providers.grok.ready) : "…"} />
        <Metric label="OpenRouter" value={providers ? String(providers.openrouter.ready) : "…"} />
        <Metric label="Est. cost" value={fmtCost(data?.summary.cost_usd)} />
        <Metric label="Claude token" value={data?.auth.token_hint ?? "—"} />
        <Metric label="Expires" value={data ? fmtExpiry(data.auth.expires_at) : "…"} />
        <Metric label="Claude model" value={data?.model ?? "…"} />
        <Metric label="Last snapshot" value={data ? fmtTime(data.at) : "…"} />
      </section>
      {data?.auth.hint ? (
        <p className="border border-destructive/40 bg-card p-3 text-[12px] text-destructive">{data.auth.hint}</p>
      ) : null}
      {providers?.grok.hint && !providers.grok.ready ? (
        <p className="border border-border bg-card p-3 text-[12px] text-muted-foreground">{providers.grok.hint}</p>
      ) : null}
      {providers?.openrouter.hint && !providers.openrouter.ready ? (
        <p className="border border-border bg-card p-3 text-[12px] text-muted-foreground">{providers.openrouter.hint}</p>
      ) : null}
      <RoutingAndCosts settings={data?.settings} catalog={data?.catalog} onSaved={load} />
      <ClaudeLoginCard auth={data?.auth} onChanged={load} />
      <GrokLoginCard snap={providers?.grok} onChanged={load} />
      <OpenRouterLoginCard snap={providers?.openrouter} onChanged={load} />
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Calls" value={data?.summary.total ?? 0} />
        <Metric label="OK / failed" value={`${data?.summary.ok ?? 0} / ${data?.summary.failed ?? 0}`} />
        <Metric label="Tokens in / out" value={`${data?.summary.input_tokens ?? 0} / ${data?.summary.output_tokens ?? 0}`} />
        <Metric label="Latency p50 / p95" value={`${data?.summary.latency_ms_p50 ?? 0} / ${data?.summary.latency_ms_p95 ?? 0} ms`} />
      </section>

      <section className="border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Purpose
            <select
              className="h-8 border border-border bg-background px-2 text-[12px] text-foreground"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            >
              <option value="all">all</option>
              {purposes.map((p) => (
                <option key={p} value={p}>
                  {p} ({data?.summary.by_purpose[p]})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Outcome
            <select
              className="h-8 border border-border bg-background px-2 text-[12px] text-foreground"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as "all" | "ok" | "fail")}
            >
              <option value="all">all</option>
              <option value="ok">ok</option>
              <option value="fail">failed</option>
            </select>
          </label>
          <label className="min-w-[180px] flex-1 grid gap-1 text-[11px] text-muted-foreground">
            Search
            <input
              className="h-8 border border-border bg-background px-2 text-[12px] text-foreground"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="id, provider, module, error, prompt"
            />
          </label>
          <button
            type="button"
            className="h-8 border border-border px-3 text-[12px]"
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Module</th>
                <th className="py-2 pr-3 font-medium">Provider</th>
                <th className="py-2 pr-3 font-medium">Purpose</th>
                <th className="py-2 pr-3 font-medium">OK</th>
                <th className="py-2 pr-3 font-medium">HTTP</th>
                <th className="py-2 pr-3 font-medium">ms</th>
                <th className="py-2 pr-3 font-medium">Tokens</th>
                <th className="py-2 pr-3 font-medium">Cost</th>
                <th className="py-2 pr-3 font-medium">Reauth</th>
                <th className="py-2 font-medium">Id</th>
              </tr>
            </thead>
            <tbody>
              {calls.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-6 text-muted-foreground">
                    No agentic calls yet. Extract, hill-climb, or a live ping will appear here.
                  </td>
                </tr>
              ) : (
                calls.map((row) => (
                  <Fragment key={row.id}>
                    <tr
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                      onClick={() => setOpenCall(openCall === row.id ? null : row.id)}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">{fmtTime(row.at)}</td>
                      <td className="py-2 pr-3">{row.module ?? "—"}</td>
                      <td className="py-2 pr-3">{row.provider ?? "—"}</td>
                      <td className="py-2 pr-3">{row.purpose}</td>
                      <td className="py-2 pr-3">{row.ok ? "ok" : "fail"}</td>
                      <td className="py-2 pr-3">{row.http_status ?? "—"}</td>
                      <td className="py-2 pr-3">{row.latency_ms}</td>
                      <td className="py-2 pr-3">
                        {row.input_tokens ?? "—"} / {row.output_tokens ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{fmtCost(row.cost_usd)}</td>
                      <td className="py-2 pr-3">{row.reauth ?? "—"}</td>
                      <td className="py-2 font-mono text-[11px]">{row.id}</td>
                    </tr>
                    {openCall === row.id ? (
                      <tr className="border-t border-border bg-background">
                        <td colSpan={11} className="p-3">
                          <div className="grid gap-2">
                            <p className="text-[11px] text-muted-foreground">
                              model {row.model} · request {row.request_id ?? "—"} · session {row.session_id ?? "—"} ·
                              source {row.oauth_source ?? "—"} · chars {row.system_chars ?? 0}/{row.user_chars ?? 0}
                            </p>
                            {row.error ? (
                              <p className="text-[12px] text-destructive">{row.error}</p>
                            ) : null}
                            <p className="text-[11px] text-muted-foreground">System preview</p>
                            <JsonBlock value={row.system_preview ?? ""} />
                            <p className="text-[11px] text-muted-foreground">User preview</p>
                            <JsonBlock value={row.user_preview ?? ""} />
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-[13px] font-medium">Reauth events</h2>
        {data?.reauth.length ? (
          <div className="grid gap-2">
            {[...data.reauth].reverse().map((event) => (
              <p key={event.id ?? `${event.at}:${event.type}`} className="border border-border p-2 text-[12px]">
                <span className="text-muted-foreground">{fmtTime(event.at)} · {event.type}</span>
                {event.error ? <span className="text-destructive"> — {event.error}</span> : null}
                {event.request_id ? (
                  <span className="block font-mono text-[11px] text-muted-foreground">{event.request_id}</span>
                ) : null}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">No refresh or 401 events yet.</p>
        )}
      </section>

      <section className="border border-border bg-card p-4">
        <h2 className="mb-3 text-[13px] font-medium">Extract runs and steps</h2>
        {data?.extract.length ? (
          <div className="grid gap-2">
            {data.extract.map((run) => (
              <div key={run.id} className="border border-border">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 p-3 text-left text-[12px]"
                  onClick={() => setOpenRun(openRun === run.id ? null : run.id)}
                >
                  <span>
                    <span className="font-medium">{run.title}</span>
                    <span className="block text-muted-foreground">
                      {run.id} · {run.kind} · {run.status} · {run.prompt_version} · {run.steps.length} steps
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-muted-foreground">{fmtTime(run.created_at)}</span>
                </button>
                {openRun === run.id ? (
                  <div className="grid gap-3 border-t border-border p-3">
                    {run.error ? <p className="text-destructive">{run.error}</p> : null}
                    {run.steps.map((step) => (
                      <div key={step.id} className="grid gap-1">
                        <p className="text-[11px] text-muted-foreground">
                          round {step.round} · {step.role} · {step.latency_ms ?? "—"} ms
                          {step.error ? ` · ${step.error}` : ""}
                        </p>
                        <JsonBlock value={{ request: step.request, response: step.response }} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">No extract runs stored yet.</p>
        )}
      </section>
    </div>
  );
}
