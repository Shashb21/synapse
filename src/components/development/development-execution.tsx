/** Owner controls for isolated development executions and their immutable history. */
"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RouteFields } from "./development-route-fields";
import { DevelopmentEvaluation } from "./development-evaluation";
import type { Experiment, DevelopmentSection } from "@/modules/development/schema";
import type { ExecutionConfig, ExecutionRoute } from "@/modules/development/execution-schema";
import type { AttemptHistoryMetadata } from "@/modules/development/execution";
import type { Execution, SectionAttempt } from "@/modules/development/execution-store";
import type { ProviderKeyView } from "@/modules/llm/api-keys";

type Role = "proposer" | "critic" | "reviser" | "internal_judge";
const labels: Record<DevelopmentSection, string> = { gap_extraction: "Gap extraction", tactic_extraction: "Tactic extraction", matching_coverage: "Matching and coverage", partial_splitting: "Partial splitting" };
const sections = Object.keys(labels) as DevelopmentSection[];
const roles: Role[] = ["proposer", "critic", "reviser", "internal_judge"];
const roleLabels: Record<Role, string> = { proposer: "Proposer", critic: "Critic", reviser: "Reviser", internal_judge: "Internal judge" };
const selectClass = "w-full rounded-lg border border-input bg-background px-2 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const active = (execution: Execution) => execution.generation_status === "queued" || execution.generation_status === "running";

/** Display frozen configuration, progress and unreviewed section output. */
function ExecutionDetail({ execution, metadata }: { execution: Execution; metadata: Record<string, AttemptHistoryMetadata> }) {
  const terminal = execution.sections.filter((item) => !["queued", "running"].includes(item.status)).length;
  return <div className="space-y-3 break-words" aria-live="polite">
    <p>Generation: {execution.generation_status} · Evaluation: {execution.evaluation_status} · {terminal}/{execution.sections.length} sections finished</p>
    <p>The evaluation status above describes the generation request; any later evaluations appear under their associated attempts.</p>
    <p>Mode: {execution.manifest.config.mode === "standard" ? "Standard" : "Single pass"} · Revision {execution.manifest.revision}</p>
    <p>Evaluator for later: {execution.manifest.config.evaluator.provider_id} / {execution.manifest.config.evaluator.model} (not requested)</p>
    <p>Execution ID: {execution.id} · Created: {execution.created_at} · Updated: {execution.updated_at}</p>
    <details><summary className="cursor-pointer">Provenance and retry policy</summary><div className="space-y-2 pt-2">
      <p>Code version: {execution.manifest.code_identity ?? "unknown"}</p>
      <p>Sources: {(execution.manifest.sources ?? []).map((source) => `${source.id} (${source.sha256})`).join(", ") || "none recorded"}</p>
      <p>References: {(execution.manifest.references ?? []).map((reference) => `${reference.id} (${reference.sha256})`).join(", ") || "none recorded"}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ modules: execution.manifest.modules, prompts: execution.manifest.prompts, prerequisites: execution.manifest.prerequisites }, null, 2)}</pre>
      <p>Interrupted or uncertain sends are not automatically resent. A user rerun creates a fresh attempt and may incur charges.</p>
      <p>Retry policy: {execution.manifest.retry_policy ? JSON.stringify(execution.manifest.retry_policy) : "not recorded"}</p>
    </div></details>
    {execution.error && <p className="text-destructive">{execution.error}</p>}
    {execution.sections.map((item) => <div key={item.id} className="border-t border-border pt-3 space-y-2"><p className="font-medium">{labels[item.section]}: {item.status}</p>{item.error && <p className="text-destructive">{item.error}</p>}
      <p>Attempt: {item.id} · Output: {item.result?.output_id ?? "none"} · Started: {item.started_at ?? "unknown"} · Finished: {item.finished_at ?? "unknown"}</p>
      <p>Prerequisite attempts: {Object.entries(item.prerequisites ?? {}).map(([name, id]) => `${labels[name as DevelopmentSection] ?? name}: ${id}`).join(", ") || "none"}</p>
      {metadata[item.id] ? <p>Generation freshness: {metadata[item.id].freshness.current ? "current" : "outdated"}{metadata[item.id].freshness.reasons.length ? ` · ${metadata[item.id].freshness.reasons.join(", ")}` : ""}</p> : <p>Generation freshness: unavailable</p>}
      {metadata[item.id]?.evaluations.length ? metadata[item.id].evaluations.map((evaluation) => <p key={evaluation.id}>Evaluation: {evaluation.status} · {evaluation.freshness}{evaluation.reasons.length ? ` · ${evaluation.reasons.join(", ")}` : ""} · Profile: {evaluation.profile_id} · Output: {evaluation.output_id} · Evaluator: {evaluation.evaluator_identity} · References: {evaluation.reference_ids.join(", ") || "none"} ({evaluation.reference_identity})</p>) : <p>Evaluation: {metadata[item.id] ? "unscored / not requested" : "unavailable"}</p>}
      {item.result && <><p>Generated output: unreviewed{item.result.reason ? ` · ${item.result.reason}` : ""}</p><details><summary className="cursor-pointer">View generated output</summary><div className="space-y-2 pt-2"><p>Unreviewed candidates</p>{item.result.candidates.length ? <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.result.candidates, null, 2)}</pre> : <p>No unreviewed candidates.</p>}<p>Original stage output</p><pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.result.output, null, 2)}</pre></div></details></>}
      {Object.entries(execution.manifest.routes[item.section] ?? {}).map(([role, route]) => route && <p key={role} className="text-muted-foreground">{role}: requested {route.requested.provider_id} / {route.requested.model}, temperature {route.requested.temperature}, max tokens {route.requested.max_tokens}, fallbacks {route.requested.fallbacks.join(", ") || "none"}; actual {route.actual.provider_id} / {route.actual.model}, temperature {route.actual_temperature ?? "not sent"}{route.actual.reason ? ` · ${route.actual.reason}` : ""}</p>)}
      {execution.calls.filter((call) => call.section_id === item.id).map((call) => <details key={call.id}><summary className="cursor-pointer">Call {call.ordinal}: {call.status}</summary><div className="space-y-1 pt-2 break-words"><p>Role: {call.request?.role ?? "unknown"} · Purpose: {call.request?.purpose ?? "unknown"} · Trace: {call.identity ?? call.id} · LLM call ID: {call.receipt?.llm_call_id ?? "unknown"}</p><p>Sent: {call.sending_at ?? "unknown"} · Settled: {call.settled_at ?? "unknown"}</p><p>Cost: {call.receipt?.cost_usd ?? call.failure_accounting?.cost_usd ?? "unknown"} · Price source: {call.receipt?.price_source ?? call.failure_accounting?.price_source ?? "unknown"}</p><p>Usage: {JSON.stringify(call.receipt?.usage ?? call.failure_accounting?.usage ?? "unknown")}</p><p>Frozen call route: {call.route ? JSON.stringify(call.route) : "unknown"}</p>{call.error && <p>{call.error}</p>}<pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{call.receipt?.text ?? "No response recorded."}</pre></div></details>)}
    </div>)}
  </div>;
}

/** Manage execution settings and read progress without driving worker delivery. */
export function DevelopmentExecution({ draft, disabled }: { draft: Experiment; disabled: boolean }) {
  const [providers, setProviders] = useState<ProviderKeyView[]>([]);
  const [config, setConfig] = useState<ExecutionConfig | null>(null);
  const [history, setHistory] = useState<Execution[]>([]);
  const [historyMetadata, setHistoryMetadata] = useState<{ inputs: string; attempts: Record<string, AttemptHistoryMetadata> }>({ inputs: "", attempts: {} });
  const freshnessController = useRef<{ inputs: string; controller: AbortController } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const root = `/api/admin/development/${draft.id}/executions`;
  const comparisonInputs = JSON.stringify([root, draft.revision, config]);
  // A result belongs to exactly one controls/source version, including during render.
  const metadata = historyMetadata.inputs === comparisonInputs ? historyMetadata.attempts : {};

  /** Publish only metadata from a still-current request. */
  function mergeMetadata(attempts: Record<string, AttemptHistoryMetadata>, signal: AbortSignal) {
    if (signal.aborted) return;
    setHistoryMetadata((current) => signal.aborted ? current : ({ inputs: comparisonInputs, attempts: { ...(current.inputs === comparisonInputs ? current.attempts : {}), ...attempts } }));
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [catalogResponse, historyResponse] = await Promise.all([fetch("/api/control", { signal: controller.signal, cache: "no-store" }), fetch(root, { signal: controller.signal, cache: "no-store" })]);
        if (!catalogResponse.ok || !historyResponse.ok) throw new Error("Unable to load execution settings or history. Reload the page.");
        const catalog = await catalogResponse.json();
        const list = await historyResponse.json();
        const available = (catalog.provider_keys as ProviderKeyView[]).filter((item) => item.auth === "api_key");
        const primary = available.find((item) => item.provider_id === catalog.defaults.primary);
        if (!primary) throw new Error("The default provider is unavailable. Reload the page.");
        const route: ExecutionRoute = { provider_id: primary.provider_id, model: primary.default_model, temperature: 0.2, max_tokens: 16000, fallbacks: ["anthropic-claude", "openai"].filter((id) => id !== primary.provider_id && available.some((item) => item.provider_id === id)) };
        setProviders(available);
        const saved = list.executions[0]?.manifest?.config as ExecutionConfig | undefined;
        const validRoute = (candidate: ExecutionRoute | undefined) => {
          const provider = available.find((item) => item.provider_id === candidate?.provider_id);
          return !!candidate && !!provider && provider.models.includes(candidate.model) && Number.isFinite(candidate.temperature) && Number.isInteger(candidate.max_tokens) && Array.isArray(candidate.fallbacks);
        };
        const complete = saved && ["standard", "single_pass"].includes(saved.mode) && validRoute(saved.evaluator) && sections.every((section) => {
          const stage = saved.stages?.[section];
          return !!stage && validRoute(stage.route) && !!stage.overrides && Object.values(stage.overrides).every(validRoute);
        });
        setConfig(complete ? saved : { mode: "standard", stages: Object.fromEntries(sections.map((section) => [section, { route: structuredClone(route), overrides: {} }])) as ExecutionConfig["stages"], evaluator: structuredClone(route) });
        if (controller.signal.aborted) return;
        setHistory(list.executions); mergeMetadata(list.history ?? {}, controller.signal); setCursor(list.next_cursor ?? null); setDelivery(list.delivery); setSelected(list.executions[0]?.id ?? null);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load execution settings."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
    // Initial settings load runs only when the experiment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const current = history.find((item) => item.id === selected);
  const selectedId = current?.id;
  const selectedStatus = current?.generation_status;
  useEffect(() => {
    if (!selectedId || (selectedStatus !== "queued" && selectedStatus !== "running")) return;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${root}/${selectedId}${config ? `?${new URLSearchParams({ config: JSON.stringify(config) })}` : ""}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Unable to refresh progress. Reload history.");
        const body = await response.json();
        if (!controller.signal.aborted) { setHistory((items) => items.map((item) => item.id === selectedId ? body.execution : item)); mergeMetadata(body.history ?? {}, controller.signal); }
      } catch { if (!controller.signal.aborted) setError("Unable to refresh progress. Reload history."); }
    }, 3000);
    return () => { controller.abort(); window.clearInterval(timer); };
    // Metadata publishing captures the controls and source version for this poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, selectedId, selectedStatus, config, draft.revision]);

  /** Recheck the first and retained pages using one invalidation/request policy. */
  async function refreshHistory(pageCursor?: string, signal = freshnessController.current?.inputs === comparisonInputs ? freshnessController.current.controller.signal : undefined) {
    if (!signal || signal.aborted) return [];
    if (!pageCursor) setHistoryMetadata({ inputs: comparisonInputs, attempts: {} });
    const params = new URLSearchParams();
    if (config) params.set("config", JSON.stringify(config));
    if (pageCursor) params.set("cursor", pageCursor);
    const response = await fetch(`${root}?${params}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("Unable to reload execution history.");
    const body = await response.json();
    if (signal.aborted) return [];
    const executions = body.executions as Execution[];
    setHistory((items) => pageCursor ? [...items, ...executions.filter((entry) => !items.some((item) => item.id === entry.id))] : [...executions, ...items.filter((item) => !executions.some((entry) => entry.id === item.id))]);
    mergeMetadata(body.history ?? {}, signal);
    setCursor(body.next_cursor ?? null);
    setSelected((current) => current ?? executions[0]?.id ?? null);
    setDelivery(body.delivery);
    if (!pageCursor) {
      // A list page cannot establish freshness for executions retained from older pages.
      const retained = history.filter((item) => !executions.some((entry) => entry.id === item.id));
      const detailParams = new URLSearchParams();
      if (config) detailParams.set("config", JSON.stringify(config));
      await Promise.all(retained.map(async (item) => {
        const detail = await fetch(`${root}/${item.id}?${detailParams}`, { signal, cache: "no-store" });
        if (!detail.ok) throw new Error("Unable to refresh older history freshness.");
        const data = await detail.json();
        mergeMetadata(data.history ?? {}, signal);
      }));
    }
    if (!signal.aborted) setError("");
    return executions;
  }
  useEffect(() => {
    if (!config || loading) return;
    const controller = new AbortController();
    freshnessController.current = { inputs: comparisonInputs, controller };
    const timer = window.setTimeout(() => {
      void refreshHistory(undefined, controller.signal).catch((failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to refresh history freshness.");
      });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // History is intentionally captured when controls or source revision change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, draft.revision, root, loading]);
  const latest = (section: DevelopmentSection): SectionAttempt | undefined => history.flatMap((item) => item.sections).find((item) => item.section === section);
  function prerequisites(target: DevelopmentSection | "all") {
    const required: DevelopmentSection[] = target === "matching_coverage" ? ["gap_extraction", "tactic_extraction"] : target === "partial_splitting" ? ["gap_extraction", "tactic_extraction", "matching_coverage"] : [];
    const result: Partial<Record<DevelopmentSection, { attempt_id: string; output_id: string }>> = {};
    for (const section of required) { const attempt = latest(section); if (!attempt || attempt.status !== "succeeded" || !attempt.result || metadata[attempt.id]?.freshness.current === false) return null; result[section] = { attempt_id: attempt.id, output_id: attempt.result.output_id }; }
    if (target === "partial_splitting") { const matching = latest("matching_coverage"); if (matching?.prerequisites.gap_extraction !== result.gap_extraction?.attempt_id || matching?.prerequisites.tactic_extraction !== result.tactic_extraction?.attempt_id) return null; }
    return result;
  }
  async function run(target: DevelopmentSection | "all") {
    if (!config) return;
    const dependencies = prerequisites(target);
    if (!dependencies) { setError("Prerequisites are missing or stale. Run the required sections again."); return; }
    setPending(true); setError("");
    try {
      const response = await fetch(root, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: draft.revision, target, config, prerequisites: dependencies }) });
      const body = await response.json();
      if (!response.ok) { if (response.status === 409) await refreshHistory(); throw new Error(typeof body.error === "string" ? body.error : "Unable to start execution."); }
      setHistory((items) => [body.execution, ...items]); setSelected(body.execution.id);
      await refreshHistory();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to start execution. Check history before retrying."); }
    finally { setPending(false); }
  }
  const locked = disabled || pending || loading || !config || !delivery?.available || history.some(active) || !draft.documents.some((item) => item.role === "source");
  return <section aria-label="Execution" className="space-y-4 border-t border-border pt-5">
    <h2 className="font-semibold">Execution</h2>
    <p className="text-muted-foreground">Generation uses source snapshots only. Outputs are unreviewed; evaluation uses saved outputs in the separate controls below. A fresh run may incur provider charges, including after an uncertain failure.</p>
    {loading && <p>Loading execution settings and history…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {delivery && !delivery.available && <p>Execution delivery unavailable: {delivery.reason ?? "Check server configuration."}</p>}
    {!draft.documents.some((item) => item.role === "source") && <p>Add a source snapshot before running.</p>}
    {config && <><label className="block space-y-1">Execution mode<select aria-label="Execution mode" className={selectClass} value={config.mode} onChange={(event) => { const mode = event.target.value as ExecutionConfig["mode"]; setConfig({ ...config, mode, stages: mode === "single_pass" ? Object.fromEntries(sections.map((section) => [section, { ...config.stages[section], overrides: config.stages[section].overrides.proposer ? { proposer: config.stages[section].overrides.proposer } : {} }])) as ExecutionConfig["stages"] : config.stages }); }}><option value="standard">Standard</option><option value="single_pass">Single pass (experimental)</option></select></label>
      <p className="text-muted-foreground">Single pass omits critique, revision and internal acceptance; switching to it removes those role overrides. Structural repair may still make additional calls.</p>
      {sections.map((section) => <details key={section} className="border-t border-border pt-3"><summary className="cursor-pointer font-medium">{labels[section]} route and roles</summary><div className="space-y-3 pt-3"><RouteFields providers={providers} value={config.stages[section].route} onChange={(route) => setConfig({ ...config, stages: { ...config.stages, [section]: { ...config.stages[section], route } } })} />{roles.map((role) => <div key={role}><label className="flex gap-2 items-center"><input type="checkbox" aria-label={`${roleLabels[role]} override`} disabled={config.mode === "single_pass" && role !== "proposer"} checked={!!config.stages[section].overrides[role]} onChange={(event) => { const overrides = { ...config.stages[section].overrides }; if (event.target.checked) overrides[role] = structuredClone(config.stages[section].route); else delete overrides[role]; setConfig({ ...config, stages: { ...config.stages, [section]: { ...config.stages[section], overrides } } }); }} />{roleLabels[role]} override</label>{config.stages[section].overrides[role] && <div className="mt-3"><RouteFields providers={providers} value={config.stages[section].overrides[role]!} onChange={(route) => setConfig({ ...config, stages: { ...config.stages, [section]: { ...config.stages[section], overrides: { ...config.stages[section].overrides, [role]: route } } } })} /></div>}</div>)}</div></details>)}
      <details className="border-t border-border pt-3"><summary className="cursor-pointer font-medium">Evaluator route (for later evaluation)</summary><div className="pt-3"><RouteFields providers={providers} value={config.evaluator} onChange={(evaluator) => setConfig({ ...config, evaluator })} /></div></details>
      <p className="text-muted-foreground">Matching requires current successful gap and tactic extraction. Partial splitting requires those results and matching built from them. Changed settings or sources can make prerequisites stale; the server checks them before every run.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={!!locked} onClick={() => void run("all")}>Run all sections</Button>{sections.map((section) => <Button key={section} variant="outline" disabled={!!locked} onClick={() => void run(section)}>{latest(section) ? "Rerun" : "Run"} {labels[section]}</Button>)}</div></>}
    <div className="border-t border-border pt-3 space-y-3"><div className="flex flex-wrap gap-2 items-center"><h3 className="font-semibold">Execution history</h3><Button variant="outline" disabled={pending || loading} onClick={() => { setPending(true); void refreshHistory().catch((failure) => setError(failure.message)).finally(() => setPending(false)); }}>Reload history</Button></div>
      {!history.length && !loading && <p>No executions yet.</p>}
      {!!history.length && <><label className="block space-y-1">Selected execution<select className={selectClass} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>{history.map((item) => <option key={item.id} value={item.id}>{item.created_at} · {item.generation_status} · {item.id}</option>)}</select></label>{current && <ExecutionDetail execution={current} metadata={metadata} />}{cursor && <Button variant="outline" disabled={pending} onClick={() => { setPending(true); void refreshHistory(cursor).catch((failure) => setError(failure.message)).finally(() => setPending(false)); }}>Load older executions</Button>}</>}
    </div>
    <DevelopmentEvaluation key={draft.id} draft={draft} execution={current} providers={providers} disabled={disabled || loading || pending} />
  </section>;
}
