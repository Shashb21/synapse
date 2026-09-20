"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEMO_JSON_PACK, DEMO_PACK, type DemoJsonFixtureMeta } from "@/lib/iegp/demo-pack";
import {
  ACTOR_FUNCTIONS,
  FUNCTION_LABELS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  type ActorFunction,
} from "@/lib/iegp/enums";

type Status = {
  llm_ready: boolean;
  anthropic: boolean;
  anthropic_model: string | null;
  anthropic_workspace: boolean;
  champion_version: string | null;
  last_hillclimb_at: string | null;
  last_error: string | null;
  gold_gap_count: number;
  key_hint: string | null;
};

type RunListItem = {
  id: string;
  kind: string;
  status: string;
  title: string;
  created_at: string;
  persist: boolean;
  prompt_version: string;
  error: string | null;
};

export function ExtractWorkbench({ initialRuns }: { initialRuns: RunListItem[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [format, setFormat] = useState<"markdown" | "json">("json");
  const [title, setTitle] = useState("HEOR stakeholder interviews");
  const [markdown, setMarkdown] = useState(DEMO_PACK[0]?.text ?? "");
  const [jsonText, setJsonText] = useState("{\n  \"blocks\": []\n}");
  const [sourceKey, setSourceKey] = useState(DEMO_PACK[0]?.id ?? "heor-interview");
  const [selectedJsonId, setSelectedJsonId] = useState<string | null>(DEMO_JSON_PACK[0]?.id ?? null);
  const [persist, setPersist] = useState(false);
  const [scoreGold, setScoreGold] = useState(true);
  const [sourceType, setSourceType] = useState<(typeof SOURCE_TYPES)[number]>("stakeholder_interview");
  const [actorName, setActorName] = useState("A. Rao");
  const [actorFunction, setActorFunction] = useState<ActorFunction>("heor");
  const [pending, setPending] = useState<"extract" | "hillclimb" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [runs, setRuns] = useState(initialRuns);

  useEffect(() => {
    void fetch("/api/extract/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => undefined);
  }, [result]);

  function applyMarkdownDemo(file: (typeof DEMO_PACK)[number]) {
    setFormat("markdown");
    setTitle(file.title);
    setMarkdown(file.text);
    setSourceType(file.source_type);
    setActorFunction(file.stakeholder_function);
    setSourceKey(file.id);
    setSelectedJsonId(null);
  }

  async function applyJsonDemo(file: DemoJsonFixtureMeta) {
    const res = await fetch(file.href);
    if (!res.ok) throw new Error(`Could not load ${file.filename}`);
    const json = (await res.json()) as Record<string, unknown>;
    setFormat("json");
    setTitle(file.title);
    setJsonText(JSON.stringify(json, null, 2));
    setSourceType(file.source_type);
    setActorFunction(file.stakeholder_function);
    setSourceKey(file.source_key);
    setSelectedJsonId(file.id);
  }

  useEffect(() => {
    const first = DEMO_JSON_PACK[0];
    if (!first) return;
    void applyJsonDemo(first).catch(() => undefined);
  }, []);

  async function refreshRuns() {
    const res = await fetch("/api/extract/runs");
    const json = (await res.json()) as { runs: RunListItem[] };
    setRuns(json.runs);
  }

  async function onExtract() {
    setError(null);
    setPending("extract");
    try {
      const payload: Record<string, unknown> = {
        format,
        title,
        persist,
        score_vs_gold: scoreGold,
        source_type: sourceType,
        stakeholder_function: actorFunction,
        actor_name: actorName,
        actor_function: actorFunction,
        wait: true,
        source_key: sourceKey,
      };
      if (format === "markdown") payload.markdown = markdown;
      else payload.json = JSON.parse(jsonText);
      const res = await fetch("/api/extract/gaps?wait=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json.error ?? "Extract failed"));
      setResult(json);
      await refreshRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extract failed");
    } finally {
      setPending(null);
    }
  }

  async function onHillclimb() {
    setError(null);
    setPending("hillclimb");
    try {
      const res = await fetch("/api/extract/hillclimb", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor_name: actorName,
          actor_function: actorFunction,
          trigger: "workbench",
        }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json.error ?? "Hill-climb failed"));
      setResult(json);
      await refreshRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hill-climb failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="border border-border bg-card p-4">
        <p className="text-[12px] text-muted-foreground">
          JSON blocks (LlamaParse items / ParsedDocument) are the preferred input. Markdown is the
          fallback. Live extract is a 3-round proposer → critic debate, then a judge. Gold scoring
          is opt-in here, not mixed into ingest. Missing ANTHROPIC_API_KEY throws. Ready-made JSON
          fixtures live in{" "}
          <code className="text-foreground">/demo-sources/json/</code>.
        </p>
        <div className="mt-3 grid gap-1 text-[12px] text-muted-foreground sm:grid-cols-2">
          <p>LLM ready: {status ? String(status.llm_ready) : "…"}</p>
          <p>Champion: {status?.champion_version ?? "…"}</p>
          <p>Model: {status?.anthropic_model ?? "not set"}</p>
          <p>Workspace header: {status ? String(status.anthropic_workspace) : "…"}</p>
          <p>Gold gaps: {status?.gold_gap_count ?? "…"}</p>
        </div>
        {status?.last_error ? (
          <p className="mt-2 text-[12px] text-destructive">{status.last_error}</p>
        ) : null}
        {!status?.llm_ready && status?.key_hint ? (
          <p className="mt-2 text-[12px] text-destructive">{status.key_hint}</p>
        ) : null}
      </section>

      <section className="grid gap-3 border border-border bg-card p-4">
        <div className="grid gap-2">
          <p className="text-[11px] text-muted-foreground">JSON test docs (preferred)</p>
          <div className="flex flex-wrap gap-2">
            {DEMO_JSON_PACK.map((file) => (
              <span key={file.id} className="inline-flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={selectedJsonId === file.id ? "default" : "outline"}
                  onClick={() => {
                    void applyJsonDemo(file).catch((err) =>
                      setError(err instanceof Error ? err.message : "Could not load JSON demo"),
                    );
                  }}
                >
                  {file.filename}
                </Button>
                <a
                  href={file.href}
                  download={file.filename}
                  className="text-[11px] text-muted-foreground"
                >
                  Download
                </a>
              </span>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Markdown fallback</p>
          <div className="flex flex-wrap gap-2">
            {DEMO_PACK.map((file) => (
              <Button
                key={file.id}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => applyMarkdownDemo(file)}
              >
                {file.filename}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
            />
          </label>
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Gold source_key
            <input
              value={sourceKey}
              onChange={(e) => setSourceKey(e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={format === "markdown"}
              onChange={() => setFormat("markdown")}
            />
            Markdown
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={format === "json"} onChange={() => setFormat("json")} />
            JSON (preferred)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
            Persist to Gaps
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={scoreGold}
              onChange={(e) => setScoreGold(e.target.checked)}
            />
            Score vs gold (eval)
          </label>
        </div>
        {format === "markdown" ? (
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            className="min-h-48 rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[12px]"
          />
        ) : (
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="min-h-48 rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[12px]"
          />
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as (typeof SOURCE_TYPES)[number])}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_TYPE_LABELS[s]}
              </option>
            ))}
          </select>
          <input
            value={actorName}
            onChange={(e) => setActorName(e.target.value)}
            placeholder="Name"
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          />
          <select
            value={actorFunction}
            onChange={(e) => setActorFunction(e.target.value as ActorFunction)}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {ACTOR_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {FUNCTION_LABELS[fn]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={Boolean(pending)} onClick={() => void onExtract()}>
            {pending === "extract" ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Extracting…
              </span>
            ) : (
              "Run extract"
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(pending)}
            onClick={() => void onHillclimb()}
          >
            {pending === "hillclimb" ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Hill-climbing…
              </span>
            ) : (
              "Run hill-climb"
            )}
          </Button>
        </div>
        {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      </section>

      {result ? (
        <section className="border border-border bg-card p-4">
          <h2 className="text-[13px] text-foreground">Latest result</h2>
          <pre className="mt-2 max-h-[480px] overflow-auto text-[11px] leading-4 text-muted-foreground">
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-[13px] text-muted-foreground">Extract runs</h2>
        {runs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">None yet.</p>
        ) : (
          <div className="grid gap-2">
            {runs.map((run) => (
              <a
                key={run.id}
                href={`/extract-runs/${run.id}`}
                className="border border-border bg-card p-3 text-[13px] no-underline"
              >
                <span className="text-[11px] text-muted-foreground">
                  {run.status} · {run.kind} · {run.prompt_version}
                  {run.persist ? " · persisted" : " · dry-run"}
                </span>
                <br />
                {run.title}
                {run.error ? (
                  <span className="block text-[12px] text-destructive">{run.error}</span>
                ) : null}
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
