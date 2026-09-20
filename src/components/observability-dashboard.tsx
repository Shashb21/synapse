"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgenticAuthStatus, AgenticCallRecord, ReauthEvent } from "@/lib/llm/agentic";

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

type Payload = {
  ok: boolean;
  at: string;
  model: string;
  auth: AgenticAuthStatus;
  summary: {
    total: number;
    ok: number;
    failed: number;
    oauth: number;
    input_tokens: number;
    output_tokens: number;
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

function OauthLoginCard({
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
      const res = await fetch("/api/llm/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        authorize_url?: string;
        instructions?: string;
        json?: unknown;
      };
      if (!res.ok) throw new Error(json.error ?? "OAuth action failed");
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
        const hay = `${row.id} ${row.purpose} ${row.error ?? ""} ${row.system_preview ?? ""} ${row.user_preview ?? ""} ${row.request_id ?? ""}`.toLowerCase();
        if (!hay.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [data?.calls, purpose, outcome, query]);

  const purposes = Object.keys(data?.summary.by_purpose ?? {}).sort();

  return (
    <div className="grid gap-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="OAuth ready" value={data ? String(data.auth.ready) : "…"} />
        <Metric label="Source" value={data?.auth.source ?? "none"} />
        <Metric label="Token" value={data?.auth.token_hint ?? "—"} />
        <Metric label="Expires" value={data ? fmtExpiry(data.auth.expires_at) : "…"} />
        <Metric label="Refresh token" value={data ? String(data.auth.has_refresh_token) : "…"} />
        <Metric label="Reauth needed" value={data ? String(data.auth.reauth_needed) : "…"} />
        <Metric label="Model" value={data?.model ?? "…"} />
        <Metric label="Last snapshot" value={data ? fmtTime(data.at) : "…"} />
      </section>
      {data?.auth.hint ? (
        <p className="border border-destructive/40 bg-card p-3 text-[12px] text-destructive">{data.auth.hint}</p>
      ) : null}
      <OauthLoginCard auth={data?.auth} onChanged={load} />
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
              placeholder="id, error, prompt preview"
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
                <th className="py-2 pr-3 font-medium">Purpose</th>
                <th className="py-2 pr-3 font-medium">OK</th>
                <th className="py-2 pr-3 font-medium">HTTP</th>
                <th className="py-2 pr-3 font-medium">ms</th>
                <th className="py-2 pr-3 font-medium">Tokens</th>
                <th className="py-2 pr-3 font-medium">Reauth</th>
                <th className="py-2 font-medium">Id</th>
              </tr>
            </thead>
            <tbody>
              {calls.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-muted-foreground">
                    No agentic calls yet. Extract, hill-climb, or a live ping will appear here.
                  </td>
                </tr>
              ) : (
                calls.map((row) => (
                  <Fragment key={row.id}>
                    <tr
                      key={row.id}
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                      onClick={() => setOpenCall(openCall === row.id ? null : row.id)}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">{fmtTime(row.at)}</td>
                      <td className="py-2 pr-3">{row.purpose}</td>
                      <td className="py-2 pr-3">{row.ok ? "ok" : "fail"}</td>
                      <td className="py-2 pr-3">{row.http_status ?? "—"}</td>
                      <td className="py-2 pr-3">{row.latency_ms}</td>
                      <td className="py-2 pr-3">
                        {row.input_tokens ?? "—"} / {row.output_tokens ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{row.reauth ?? "—"}</td>
                      <td className="py-2 font-mono text-[11px]">{row.id}</td>
                    </tr>
                    {openCall === row.id ? (
                      <tr className="border-t border-border bg-background">
                        <td colSpan={8} className="p-3">
                          <div className="grid gap-2">
                            <p className="text-[11px] text-muted-foreground">
                              request {row.request_id ?? "—"} · session {row.session_id ?? "—"} · source{" "}
                              {row.oauth_source ?? "—"} · chars {row.system_chars ?? 0}/{row.user_chars ?? 0}
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
