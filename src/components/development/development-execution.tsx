/** Owner controls for isolated development executions and their immutable history. */
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Experiment, DevelopmentSection } from "@/modules/development/schema";
import type { ExecutionConfig, ExecutionRoute } from "@/modules/development/execution-schema";
import type { Execution, SectionAttempt } from "@/modules/development/execution-store";
import type { ProviderKeyView } from "@/modules/llm/api-keys";

type Role = "proposer" | "critic" | "reviser" | "internal_judge";
const labels: Record<DevelopmentSection, string> = { gap_extraction: "Gap extraction", tactic_extraction: "Tactic extraction", matching_coverage: "Matching and coverage", partial_splitting: "Partial splitting" };
const sections = Object.keys(labels) as DevelopmentSection[];
const roles: Role[] = ["proposer", "critic", "reviser", "internal_judge"];
const roleLabels: Record<Role, string> = { proposer: "Proposer", critic: "Critic", reviser: "Reviser", internal_judge: "Internal judge" };
const selectClass = "w-full rounded-lg border border-input bg-background px-2 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const active = (execution: Execution) => execution.generation_status === "queued" || execution.generation_status === "running";

/** Edit one complete requested route using the owner-readable provider catalog. */
function RouteFields({ value, onChange, providers }: { value: ExecutionRoute; onChange: (route: ExecutionRoute) => void; providers: ProviderKeyView[] }) {
  const provider = providers.find((item) => item.provider_id === value.provider_id);
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className="block space-y-1">Provider<select className={selectClass} value={value.provider_id} onChange={(event) => { const next = providers.find((item) => item.provider_id === event.target.value); if (next) onChange({ ...value, provider_id: next.provider_id, model: next.default_model, fallbacks: value.fallbacks.filter((id) => id !== next.provider_id) }); }}>{providers.map((item) => <option key={item.provider_id} value={item.provider_id}>{item.label} ({item.status === "configured" ? "key present" : "no key"})</option>)}</select></label>
    <label className="block space-y-1">Model<select className={selectClass} value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value })}>{provider?.models.map((model) => <option key={model}>{model}</option>)}</select></label>
    <label className="block space-y-1">Temperature<Input type="number" min="0" max="2" step="0.1" value={value.temperature} onChange={(event) => onChange({ ...value, temperature: Number(event.target.value) })} /></label>
    <label className="block space-y-1">Maximum output tokens<Input type="number" min="256" max="64000" step="1" value={value.max_tokens} onChange={(event) => onChange({ ...value, max_tokens: Number(event.target.value) })} /></label>
    <fieldset className="sm:col-span-2"><legend>Allowed fallbacks (in listed order)</legend><div className="flex flex-wrap gap-3 mt-1">{providers.filter((item) => item.provider_id !== value.provider_id).map((item) => <label key={item.provider_id} className="flex gap-1 items-center"><input type="checkbox" checked={value.fallbacks.includes(item.provider_id)} onChange={(event) => onChange({ ...value, fallbacks: event.target.checked ? [...value.fallbacks, item.provider_id] : value.fallbacks.filter((id) => id !== item.provider_id) })} />{item.label}</label>)}</div><p className="text-muted-foreground">Order: {value.fallbacks.join(", ") || "none"}</p></fieldset>
  </div>;
}

/** Display frozen configuration, progress and unreviewed section output. */
function ExecutionDetail({ execution }: { execution: Execution }) {
  const terminal = execution.sections.filter((item) => !["queued", "running"].includes(item.status)).length;
  return <div className="space-y-3 break-words" aria-live="polite">
    <p>Generation: {execution.generation_status} · Evaluation: {execution.evaluation_status} · {terminal}/{execution.sections.length} sections finished</p>
    <p>Mode: {execution.manifest.config.mode === "standard" ? "Standard" : "Single pass"} · Revision {execution.manifest.revision}</p>
    <p>Evaluator for later: {execution.manifest.config.evaluator.provider_id} / {execution.manifest.config.evaluator.model} (not requested)</p>
    {execution.error && <p className="text-destructive">{execution.error}</p>}
    {execution.sections.map((item) => <div key={item.id} className="border-t border-border pt-3 space-y-2"><p className="font-medium">{labels[item.section]}: {item.status}</p>{item.error && <p className="text-destructive">{item.error}</p>}
      {item.result && <><p>Generated output: unreviewed{item.result.reason ? ` · ${item.result.reason}` : ""}</p><details><summary className="cursor-pointer">View generated output</summary><div className="space-y-2 pt-2"><p>Unreviewed candidates</p>{item.result.candidates.length ? <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.result.candidates, null, 2)}</pre> : <p>No unreviewed candidates.</p>}<p>Original stage output</p><pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.result.output, null, 2)}</pre></div></details></>}
      {Object.entries(execution.manifest.routes[item.section] ?? {}).map(([role, route]) => route && <p key={role} className="text-muted-foreground">{role}: requested {route.requested.provider_id} / {route.requested.model}, temperature {route.requested.temperature}, max tokens {route.requested.max_tokens}, fallbacks {route.requested.fallbacks.join(", ") || "none"}; actual {route.actual.provider_id} / {route.actual.model}, temperature {route.actual_temperature ?? "not sent"}{route.actual.reason ? ` · ${route.actual.reason}` : ""}</p>)}
      {execution.calls.filter((call) => call.section_id === item.id).map((call) => <p className="text-muted-foreground" key={call.id}>Call {call.ordinal}: {call.status}{call.error ? ` · ${call.error}` : ""}</p>)}
    </div>)}
  </div>;
}

/** Manage execution settings and read progress without driving worker delivery. */
export function DevelopmentExecution({ draft, disabled }: { draft: Experiment; disabled: boolean }) {
  const [providers, setProviders] = useState<ProviderKeyView[]>([]);
  const [config, setConfig] = useState<ExecutionConfig | null>(null);
  const [history, setHistory] = useState<Execution[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const root = `/api/admin/development/${draft.id}/executions`;

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
        setConfig({ mode: "standard", stages: Object.fromEntries(sections.map((section) => [section, { route: structuredClone(route), overrides: {} }])) as ExecutionConfig["stages"], evaluator: structuredClone(route) });
        setHistory(list.executions); setDelivery(list.delivery); setSelected(list.executions[0]?.id ?? null);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load execution settings."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [root]);

  const current = history.find((item) => item.id === selected);
  const selectedId = current?.id;
  const selectedStatus = current?.generation_status;
  useEffect(() => {
    if (!selectedId || (selectedStatus !== "queued" && selectedStatus !== "running")) return;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${root}/${selectedId}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Unable to refresh progress. Reload history.");
        const body = await response.json();
        if (!controller.signal.aborted) setHistory((items) => items.map((item) => item.id === selectedId ? body.execution : item));
      } catch { if (!controller.signal.aborted) setError("Unable to refresh progress. Reload history."); }
    }, 3000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [root, selectedId, selectedStatus]);

  async function refreshHistory() {
    const response = await fetch(root, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to reload execution history.");
    const body = await response.json();
    const executions = body.executions as Execution[];
    setHistory(executions);
    setSelected((current) => executions.some((item) => item.id === current) ? current : executions[0]?.id ?? null);
    setDelivery(body.delivery);
    return executions;
  }
  const latest = (section: DevelopmentSection): SectionAttempt | undefined => history.flatMap((item) => item.sections).find((item) => item.section === section);
  function prerequisites(target: DevelopmentSection | "all") {
    const required: DevelopmentSection[] = target === "matching_coverage" ? ["gap_extraction", "tactic_extraction"] : target === "partial_splitting" ? ["gap_extraction", "tactic_extraction", "matching_coverage"] : [];
    const result: Partial<Record<DevelopmentSection, { attempt_id: string; output_id: string }>> = {};
    for (const section of required) { const attempt = latest(section); if (!attempt || attempt.status !== "succeeded" || !attempt.result) return null; result[section] = { attempt_id: attempt.id, output_id: attempt.result.output_id }; }
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
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to start execution. Check history before retrying."); }
    finally { setPending(false); }
  }
  const locked = disabled || pending || loading || !config || !delivery?.available || history.some(active) || !draft.documents.some((item) => item.role === "source");
  return <section aria-label="Execution" className="space-y-4 border-t border-border pt-5">
    <h2 className="font-semibold">Execution</h2>
    <p className="text-muted-foreground">Generation uses source snapshots only. Outputs are unreviewed; evaluation is separate and is not run here. A fresh run may incur provider charges, including after an uncertain failure.</p>
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
      {!!history.length && <><label className="block space-y-1">Selected execution<select className={selectClass} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>{history.map((item) => <option key={item.id} value={item.id}>{item.created_at} · {item.generation_status} · {item.id}</option>)}</select></label>{current && <ExecutionDetail execution={current} />}</>}
    </div>
  </section>;
}
