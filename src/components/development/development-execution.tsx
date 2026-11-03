/** Owner controls for isolated development executions and their immutable history. */
"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkflowFacts, WorkflowStep } from "./development-workflow";
import { Button } from "@/components/ui/button";
import { RouteFields } from "./development-route-fields";
import { presentationReason } from "./development-presentation";
import { CallEvidence, DevelopmentResults } from "./development-results";
import { DevelopmentComparison } from "./development-comparison";
import { currentPrerequisites, effectiveRoute, generationReadiness } from "./development-readiness";
import { executionConfigSchema } from "@/modules/development/execution-schema";
import { CostPreview, CostStartFields, DevelopmentCosts } from "./development-costs";
import type { CostControls } from "@/modules/development/cost-schema";
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
  return <div className="space-y-3 break-words">
    <p>Generation: {execution.generation_status} · {terminal}/{execution.sections.length} sections finished</p>
    <p>Viewing a saved run. Its output and settings are preserved; current edits do not rewrite this record.</p>
    <p>Mode: {execution.manifest.config?.mode === "standard" ? "Standard" : execution.manifest.config?.mode === "single_pass" ? "Single pass" : "unavailable"} · Revision {execution.manifest.revision}</p>

    <p>A fresh run may incur provider charges. Interrupted or uncertain sends are not automatically resent.</p>
    <details><summary className="cursor-pointer">Provenance and retry policy</summary><div className="space-y-2 pt-2">
      <p className="break-all">Execution ID: {execution.id} · Created: {execution.created_at} · Updated: {execution.updated_at}</p>
      <p>Code version: {execution.manifest.code_identity ?? "unknown"}</p>
      <p>Sources: {(execution.manifest.sources ?? []).map((source) => `${source.id} (${source.sha256})`).join(", ") || "none recorded"}</p>
      <p>References: {(execution.manifest.references ?? []).map((reference) => `${reference.id} (${reference.sha256})`).join(", ") || "none recorded"}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ config: execution.manifest.config, modules: execution.manifest.modules, prompts: execution.manifest.prompts, prerequisites: execution.manifest.prerequisites }, null, 2)}</pre>
      <p>Interrupted or uncertain sends are not automatically resent. A user rerun creates a fresh attempt and may incur charges.</p>
      <p>Retry policy: {execution.manifest.retry_policy ? JSON.stringify(execution.manifest.retry_policy) : "not recorded"}</p>
    </div></details>
    {execution.error && <p className="text-destructive">{execution.error}</p>}
    {execution.sections.map((item) => <div key={item.id} className="border-t border-border pt-3 space-y-2"><p className="font-medium">{labels[item.section]}: {item.status}</p>{item.error && <p className="text-destructive">{item.error}</p>}
      <details><summary className="cursor-pointer">Attempt identifiers and prerequisites</summary><div className="space-y-2 pt-2 break-all"><p>Attempt: {item.id} · Output: {item.result?.output_id ?? "none"} · Started: {item.started_at ?? "unknown"} · Finished: {item.finished_at ?? "unknown"}</p>
      <p>Prerequisite attempts: {Object.entries(item.prerequisites ?? {}).map(([name, id]) => `${labels[name as DevelopmentSection] ?? name}: ${id}`).join(", ") || "none"}</p></div></details>
      <DevelopmentResults attempt={item} />
      {metadata[item.id] ? <p>Generation freshness: {metadata[item.id].freshness.current ? "current" : "outdated"}{metadata[item.id].freshness.reasons.length ? ` · ${metadata[item.id].freshness.reasons.map(presentationReason).join(", ")}` : ""}</p> : <p>Generation freshness: unavailable</p>}
      {metadata[item.id]?.freshness.current === false && <p>Review current settings, then explicitly rerun this section in Run to update the output. This saved run stays unchanged.</p>}
      {metadata[item.id]?.evaluations.length ? metadata[item.id].evaluations.map((evaluation) => <div key={evaluation.id} className="space-y-2"><p>Evaluation: {evaluation.status} · {evaluation.freshness}{evaluation.reasons.length ? ` · ${evaluation.reasons.map(presentationReason).join(", ")}` : ""} · Profile: {evaluation.profile_id}{evaluation.profile_version ? `@${evaluation.profile_version}` : ""}</p><details><summary className="cursor-pointer">Associated evaluation identifiers</summary><p className="break-all pt-2">Evaluation ID: {evaluation.id} · Output: {evaluation.output_id} · Evaluator: {evaluation.evaluator_identity} · References: {evaluation.reference_ids.join(", ") || "none"} ({evaluation.reference_identity})</p></details></div>) : <p>Evaluation: {metadata[item.id] ? "unscored / not requested" : "unavailable"}</p>}

      {(execution.calls ?? []).filter((call) => call.section_id === item.id).map((call) => <div key={call.id}>{call.error && <p role="alert" className="text-destructive">Call {call.ordinal}: {call.error}</p>}{call.receipt?.cost_usd == null && call.failure_accounting?.cost_usd == null && <p>Call {call.ordinal} cost: unknown. Review call evidence before rerunning.</p>}</div>)}
      <details><summary className="cursor-pointer">Saved model routes and call evidence</summary><div className="space-y-2 pt-2">
      {Object.entries(execution.manifest.routes?.[item.section] ?? {}).map(([role, route]) => route && <p key={role} className="text-muted-foreground">{role}: requested {route.requested.provider_id} / {route.requested.model}, temperature {route.requested.temperature}, max tokens {route.requested.max_tokens}, fallbacks {route.requested.fallbacks.join(", ") || "none"}; actual {route.actual.provider_id} / {route.actual.model}, temperature {route.actual_temperature ?? "not sent"}{route.actual.reason ? ` · ${route.actual.reason}` : ""}</p>)}
      {(execution.calls ?? []).filter((call) => call.section_id === item.id).map((call) => <CallEvidence key={call.id} call={call} />)}</div></details>
    </div>)}
  </div>;
}

/** Manage execution settings and read progress without driving worker delivery. */
export function DevelopmentExecution({ draft, disabled, disabledReason, step, onNavigate, onStaleRevision, onWorkflowChange }: { draft: Experiment; disabled: boolean; disabledReason?: string; step: WorkflowStep; onNavigate: (step: WorkflowStep) => void; onStaleRevision: () => void; onWorkflowChange: (facts: WorkflowFacts, hasSources: boolean) => void }) {
  const [loadVersion, setLoadVersion] = useState(0);
  const [historyState, setHistoryState] = useState<WorkflowFacts["history"]>("loading");
  const [costControls, setCostControls] = useState<CostControls>({ allowance_usd: 0, unknown_acknowledged: false });
  const [providers, setProviders] = useState<ProviderKeyView[]>([]);
  const [config, setConfig] = useState<ExecutionConfig | null>(null);
  const [history, setHistory] = useState<Execution[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [historyMetadata, setHistoryMetadata] = useState<{ inputs: string; attempts: Record<string, AttemptHistoryMetadata> }>({ inputs: "", attempts: {} });
  const freshnessController = useRef<{ inputs: string; controller: AbortController } | null>(null);
  const historyRefreshSequence = useRef(0);
  const historyPageSequence = useRef(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
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
        setHistoryState("ready"); setHistory(list.executions); mergeMetadata(list.history ?? {}, controller.signal); setCursor(list.next_cursor ?? null); setDelivery(list.delivery); setSelected(list.executions[0]?.id ?? null);
      } catch (failure) { if (!controller.signal.aborted) { setHistoryState("unavailable"); setError(failure instanceof Error ? failure.message : "Unable to load execution settings."); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
    // Initial settings load runs only when the experiment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, loadVersion]);

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
    // A page only covers older records, so it cannot supersede a full refresh.
    const sequence = pageCursor ? ++historyPageSequence.current : ++historyRefreshSequence.current;
    const pageSequenceAtStart = historyPageSequence.current;
    const displayedHistory = historyRef.current;
    const isCurrent = () => !signal.aborted && (pageCursor ? historyPageSequence.current : historyRefreshSequence.current) === sequence;
    if (!pageCursor) setHistoryMetadata((current) => {
      if (!isCurrent()) return current;
      if (current.inputs !== comparisonInputs) return { inputs: comparisonInputs, attempts: {} };
      const attempts = { ...current.attempts };
      for (const item of displayedHistory) for (const attempt of item.sections) delete attempts[attempt.id];
      return { inputs: comparisonInputs, attempts };
    });
    try {
      const params = new URLSearchParams();
      if (config) params.set("config", JSON.stringify(config));
      if (pageCursor) params.set("cursor", pageCursor);
      const response = await fetch(`${root}?${params}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Unable to reload execution history.");
      const body = await response.json();
      if (!isCurrent()) return [];
      const executions = body.executions as Execution[];
      const attempts = { ...(body.history ?? {}) } as Record<string, AttemptHistoryMetadata>;
      if (!pageCursor) {
        // A list page cannot establish freshness for executions retained from older pages.
        const retained = displayedHistory.filter((item) => !executions.some((entry) => entry.id === item.id));
        const detailParams = new URLSearchParams();
        if (config) detailParams.set("config", JSON.stringify(config));
        const details = await Promise.all(retained.map(async (item) => {
          const detail = await fetch(`${root}/${item.id}?${detailParams}`, { signal, cache: "no-store" });
          if (!detail.ok) throw new Error("Unable to refresh older history freshness.");
          return detail.json();
        }));
        for (const detail of details) Object.assign(attempts, detail.history ?? {});
      }
      if (!isCurrent()) return [];
      // Only the newest page can establish whether another run is safe.
      if (!pageCursor) setHistoryState("ready");
      setHistory((items) => !isCurrent() ? items : pageCursor ? [...items, ...executions.filter((entry) => !items.some((item) => item.id === entry.id))] : [...executions, ...items.filter((item) => !executions.some((entry) => entry.id === item.id))]);
      setHistoryMetadata((current) => !isCurrent() ? current : ({ inputs: comparisonInputs, attempts: { ...(current.inputs === comparisonInputs ? current.attempts : {}), ...attempts } }));
      setCursor((current) => isCurrent() && (pageCursor || historyPageSequence.current === pageSequenceAtStart) ? body.next_cursor ?? null : current);
      setSelected((current) => isCurrent() ? current ?? executions[0]?.id ?? null : current);
      setDelivery((current) => isCurrent() ? body.delivery : current);
      setError((current) => isCurrent() ? "" : current);
      return executions;
    } catch (failure) {
      if (!pageCursor && isCurrent()) setHistoryState("unavailable");
      setError((current) => isCurrent() ? (failure instanceof Error ? failure.message : "Unable to reload execution history.") : current);
      return [];
    }
  }
  useEffect(() => {
    if (!config || loading) return;
    const controller = new AbortController();
    freshnessController.current = { inputs: comparisonInputs, controller };
    const scheduledSequence = historyRefreshSequence.current;
    const timer = window.setTimeout(() => {
      if (historyRefreshSequence.current !== scheduledSequence) return;
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
    return currentPrerequisites(target, history.flatMap(item => item.sections), metadata);
  }
  async function run(target: DevelopmentSection | "all") {
    if (!config || readiness(target).length) return;
    if (!Number.isFinite(costControls.allowance_usd) || costControls.allowance_usd < 0) { setError("Enter a finite nonnegative generation allowance."); return; }
    const dependencies = prerequisites(target);
    if (!dependencies) { setError("Prerequisites are missing or stale. Run the required sections again."); return; }
    setPending(true); setError("");
    // Each new execution needs its own acknowledgment, even after a lost response.
    setCostControls(current => ({ ...current, unknown_acknowledged: false }));
    try {
      const response = await fetch(root, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: draft.revision, target, config, prerequisites: dependencies, cost_controls: costControls }) });
      const body = await response.json();
      if (!response.ok) { if (body.code === "stale_revision") onStaleRevision(); if (response.status === 409) await refreshHistory(); throw new Error(typeof body.error === "string" ? body.error : "Unable to start execution."); }
      setHistory((items) => [body.execution, ...items]); setSelected(body.execution.id);
      await refreshHistory();
    } catch (failure) { setHistoryState("unavailable"); setError(`${failure instanceof Error ? failure.message : "Unable to start execution."} Check and reload history before retrying; the request may have been accepted.`); }
    finally { setPending(false); }
  }
  /** Copy a complete frozen configuration without synthesizing missing legacy defaults. */
  function copyConfiguration(execution: Execution) {
    const saved = execution.manifest?.config;
    const parsed = executionConfigSchema.safeParse(saved);
    const completeRoute = (route: ExecutionRoute | undefined) => !!route && ["provider_id", "model", "temperature", "max_tokens", "fallbacks"].every(key => Object.hasOwn(route, key));
    if (!saved || !Object.hasOwn(saved, "mode") || !parsed.success || !completeRoute(saved.evaluator) || !sections.every(section => saved.stages?.[section]?.overrides && completeRoute(saved.stages[section].route) && Object.values(saved.stages[section].overrides).every(completeRoute))) {
      setError("Saved configuration is incomplete or unsupported. It cannot be copied exactly."); return;
    }
    setConfig(structuredClone(saved)); setError("");
    const sourceChanged = JSON.stringify((execution.manifest.sources ?? []).map(source => [source.id, source.sha256, source.parsed_sha256])) !== JSON.stringify(draft.documents.filter(source => source.role === "source").map(source => [source.id, source.sha256, source.parsed_sha256]));
    setCopyMessage(`Copied configuration from execution ${execution.id} (source revision ${execution.manifest.revision}). Review settings, then explicitly Run a section or Run all sections to generate. Experiment documents: ${sourceChanged ? "changed or unavailable compared with the saved execution" : "match the saved execution"}. Current experiment documents and prerequisites apply; the server validates freshness before running.`);
  }
  const hasSources = draft.documents.some(item => item.role === "source");
  const latestStatus = history[0]?.generation_status ?? null;
  const savedSettings = !!history[0]?.manifest?.config;
  useEffect(() => {
    onWorkflowChange({ history: historyState, latestStatus, savedSettings, deliveryAvailable: !!delivery?.available }, hasSources);
  }, [historyState, latestStatus, savedSettings, delivery?.available, hasSources, onWorkflowChange]);
  const readiness = (target: DevelopmentSection | "all") => {
    const blockers = generationReadiness({ disabled, disabledReason, pending, loading, historyState, deliveryAvailable: !!delivery?.available, active: history.some(active), hasSources, config, providers, allowance: costControls.allowance_usd }, target);
    const sources = draft.documents.filter(item => item.role === "source");
    if (sources.length && (sources.length > 100 || sources.some(item => item.compatibility !== "compatible"))) blockers.push("Choose 1–100 compatible experiment documents before running.");
    if (target !== "all" && !prerequisites(target)) blockers.push("Run the latest successful prerequisites with current sources and settings first; reload history if freshness is unavailable.");
    return blockers;
  };
  const allBlockers = readiness("all");
  return <section aria-label="Execution" className="space-y-4" hidden={step === "documents"}>
    <p className="text-muted-foreground">Generation uses experiment documents only. Outputs are unreviewed; evaluation uses saved outputs in Results. A fresh run may incur provider charges, including after an uncertain failure.</p>
    {copyMessage && <p role="status">{copyMessage}</p>}
    {loading && <p>Loading execution settings and history…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {delivery && !delivery.available && <p>Execution delivery unavailable: {delivery.reason ?? "Check server configuration."}</p>}
    <section hidden={step !== "settings"} aria-labelledby="settings-heading" className="space-y-4">
    <h3 id="settings-heading" className="text-lg font-semibold">Test settings</h3>
    <p className="text-muted-foreground">Review the mode and model routes. Settings are saved with each execution; changing these controls does not run generation.</p>
    {config && <><label className="block space-y-1">Execution mode<select aria-label="Execution mode" className={selectClass} value={config.mode} onChange={(event) => { const mode = event.target.value as ExecutionConfig["mode"]; setConfig({ ...config, mode, stages: mode === "single_pass" ? Object.fromEntries(sections.map((section) => [section, { ...config.stages[section], overrides: config.stages[section].overrides.proposer ? { proposer: config.stages[section].overrides.proposer } : {} }])) as ExecutionConfig["stages"] : config.stages }); }}><option value="standard">Standard</option><option value="single_pass">Single pass (experimental)</option></select></label>
      <p id="single-pass-explanation" className="text-muted-foreground">Single pass omits critique, revision and internal acceptance; switching to it removes those role overrides. Structural repair may still make additional calls.</p>
      {sections.map((section) => <details key={section} className="border-t border-border pt-3"><summary className="cursor-pointer font-medium">{labels[section]} route and roles</summary><div className="space-y-3 pt-3"><RouteFields providers={providers} value={config.stages[section].route} onChange={(route) => setConfig({ ...config, stages: { ...config.stages, [section]: { ...config.stages[section], route } } })} />{roles.map((role) => <div key={role}><label className="flex gap-2 items-center"><input type="checkbox" aria-label={`${roleLabels[role]} override`} aria-describedby="single-pass-explanation" disabled={config.mode === "single_pass" && role !== "proposer"} checked={!!config.stages[section].overrides[role]} onChange={(event) => { const overrides = { ...config.stages[section].overrides }; if (event.target.checked) overrides[role] = structuredClone(config.stages[section].route); else delete overrides[role]; setConfig({ ...config, stages: { ...config.stages, [section]: { ...config.stages[section], overrides } } }); }} />{roleLabels[role]} override</label>{config.stages[section].overrides[role] && <div className="mt-3"><RouteFields providers={providers} value={config.stages[section].overrides[role]!} onChange={(route) => setConfig({ ...config, stages: { ...config.stages, [section]: { ...config.stages[section], overrides: { ...config.stages[section].overrides, [role]: route } } } })} /></div>}</div>)}</div></details>)}

      <details className="border-t border-border pt-3"><summary className="cursor-pointer font-medium">Legacy evaluator route (legacy history comparisons only)</summary><div className="pt-3"><p>These settings apply only to older evaluation associations. Use the per-section evaluator settings in Results for new evaluations.</p><RouteFields providers={providers} value={config.evaluator} onChange={(evaluator) => setConfig({ ...config, evaluator })} /></div></details>
    </>}
    </section>
    <section hidden={step !== "run"} aria-labelledby="run-heading" className="space-y-4">
      <h3 id="run-heading" className="text-lg font-semibold">Run</h3>
      {!hasSources && <p>Add an experiment document in Documents before running.</p>}
      {latestStatus && <p role="status">Latest run: {latestStatus}. View saved outputs and errors in Results.</p>}
      {config && <>
      <p className="text-muted-foreground">Matching requires current successful gap and tactic extraction. Partial splitting requires those results and matching built from them. Changed settings or sources can make prerequisites stale; the server checks them before every run.</p>
      <CostStartFields value={costControls} onChange={setCostControls} />
      <CostPreview root={`/api/admin/development/${draft.id}`} mode={config.mode} />
      {historyState === "unavailable" && <><p id="run-history-status">{pending || loading ? "Wait for the current history operation." : "Reload saved history to check whether a run is active."}</p><Button variant="outline" aria-describedby="run-history-status" disabled={pending || loading} onClick={() => { setPending(true); void refreshHistory().finally(() => setPending(false)); }}>Reload history before running</Button></>}
      <div id="run-readiness" role="status" aria-live="polite">{allBlockers.length ? <><p>Before running all sections:</p><ul className="list-disc pl-5">{allBlockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></> : <p>Ready to run all sections.</p>}</div>
      <div className="flex flex-wrap gap-2">{allBlockers.some(blocker => /source snapshot|experiment document/.test(blocker)) && <Button variant="outline" onClick={() => onNavigate("documents")}>Go to Documents to add or review sources</Button>}{allBlockers.some(blocker => /model settings|credentials/.test(blocker)) && <Button variant="outline" onClick={() => onNavigate("settings")}>Go to Test settings</Button>}</div>
      <p>Mode: {config.mode === "single_pass" ? "Single pass (proposer only)" : "Standard (proposer, critic, reviser and internal judge)"}. A zero allowance or unknown prices can pause execution; review the spending controls above.</p>
      <details><summary className="cursor-pointer">Active model roles</summary>{sections.map(section => <div key={section}><p className="font-medium">{labels[section]}</p>{(config.mode === "single_pass" ? roles.slice(0, 1) : roles).map(role => { const route = config.stages[section].overrides[role] ?? config.stages[section].route; const actual = effectiveRoute(route, providers); return <p key={role}>{roleLabels[role]}: {actual ? `${actual.provider_id} / ${actual.model}${actual.fallback ? ` (fallback: ${route.provider_id} credentials unavailable)` : ""}` : "No configured provider available"}</p>; })}</div>)}</details>
      <div className="flex flex-wrap gap-2"><Button aria-describedby="run-readiness" disabled={!!allBlockers.length} onClick={() => void run("all")}>Run all sections</Button>{sections.map((section) => { const blockers = readiness(section); const shared = allBlockers.every(blocker => blockers.includes(blocker)); return <div key={section}><Button variant="outline" aria-describedby={`${shared ? "run-readiness " : ""}readiness-${section}`} disabled={!!blockers.length} onClick={() => void run(section)}>{latest(section) ? "Rerun" : "Run"} {labels[section]}</Button><div id={`readiness-${section}`}>{(shared ? blockers.filter(blocker => !allBlockers.includes(blocker)) : blockers).map(blocker => <p key={blocker}>{blocker}</p>)}</div></div>; })}</div></>}
    </section>
    <section hidden={step !== "results"} aria-labelledby="results-heading" className="space-y-4">
    <h3 id="results-heading" className="text-lg font-semibold">Results</h3>
    <p>Read generated output first. Evaluation is optional; saved history and comparison preserve earlier evidence.</p>
    {loading && <p role="status">Loading saved runs…</p>}
    <div className="border-t border-border pt-3 space-y-3"><div className="flex flex-wrap gap-2 items-center"><h4 className="font-semibold">Saved run history</h4><Button variant="outline" aria-describedby="history-action-status" disabled={pending || loading} onClick={() => { if (!config) { setLoading(true); setHistoryState("loading"); setLoadVersion(current => current + 1); return; } setPending(true); void refreshHistory().catch((failure) => setError(failure.message)).finally(() => setPending(false)); }}>Reload history</Button></div>
      <p id="history-action-status">{pending || loading ? "Wait for the current history operation." : "History actions are available."}</p>
      {!history.length && historyState === "ready" && <p>No executions yet. Add experiment documents and use Run to generate output. Evaluation is optional.</p>}
      {historyState === "unavailable" && <p>Saved history unavailable. Reload history before starting another run.</p>}
      {!!history.length && <><label className="block space-y-1">Selected execution<select className={selectClass} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>{history.map((item) => <option key={item.id} value={item.id}>{item.created_at} · {item.generation_status} · {item.id}</option>)}</select></label>{current && <><Button variant="outline" aria-describedby="copy-config-status" disabled={disabled || loading || pending} onClick={() => copyConfiguration(current)}>Copy selected configuration</Button><p id="copy-config-status">{disabled ? "Save or refresh the experiment before copying settings." : loading || pending ? "Wait for the current operation before copying settings." : "Copy settings to review before running."}</p><ExecutionDetail execution={current} metadata={metadata} /><p>Review Test settings before rerunning. This action uses current settings and experiment documents; the selected saved run stays unchanged.</p><div id="results-run-readiness" role="status">{allBlockers.length ? <><p>Before rerunning all sections:</p><ul className="list-disc pl-5">{allBlockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></> : <p>Ready to rerun all sections.</p>}</div><Button variant="outline" aria-describedby="results-run-readiness" disabled={!!allBlockers.length} onClick={() => void run("all")}>Rerun with current settings</Button><DevelopmentCosts key={current.id} root={`${root}/${current.id}/costs`} account={current.cost} disabled={disabled} onChange={cost => setHistory(items => items.map(item => item.id === current.id ? { ...item, cost } : item))} /></>}{cursor && <Button variant="outline" aria-describedby="history-action-status" disabled={pending || loading} onClick={() => { setPending(true); void refreshHistory(cursor).catch((failure) => setError(failure.message)).finally(() => setPending(false)); }}>Load older executions</Button>}</>}
    </div>
    <DevelopmentEvaluation key={draft.id} draft={draft} execution={current} providers={providers} disabled={disabled || loading || pending} onHistoryChange={() => { void refreshHistory().catch((failure) => setError(failure.message)); }} />
    <DevelopmentComparison onCopy={copyConfiguration} />
    </section>
  </section>;
}
