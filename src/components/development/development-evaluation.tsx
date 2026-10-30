/** Versioned rubric drafts and independent evaluations of exact saved generation outputs. */
"use client";

import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RouteFields, routeSelectClass } from "./development-route-fields";
import { profileInputSchema, type Criterion, type EvaluationProfile } from "@/modules/development/profile-schema";
import { compareEvaluation } from "@/modules/development/evaluation-freshness";
import { evaluationConfigSchema, startEvaluationSchema, type EvaluationConfig } from "@/modules/development/evaluation-schema";
import type { DevelopmentDocument, DevelopmentSection, Experiment } from "@/modules/development/schema";
import type { Execution } from "@/modules/development/execution-store";
import type { Evaluation, RatioMeasure } from "@/modules/development/evaluation-store";
import type { ProviderKeyView } from "@/modules/llm/api-keys";

const labels: Record<DevelopmentSection, string> = { gap_extraction: "Gap extraction", tactic_extraction: "Tactic extraction", matching_coverage: "Matching and coverage", partial_splitting: "Partial splitting" };
const sections = Object.keys(labels) as DevelopmentSection[];
const anchors = ["0", "1", "2", "3", "4"] as const;
const activeStatuses = new Set(["queued", "running", "sending", "received"]);
const textClass = `${routeSelectClass} min-h-20`;
type CriterionDraft = Omit<Criterion, "weight" | "threshold"> & { weight: string; threshold: string };
type ProfileDraft = { name: string; defaults: CriterionDraft[]; sections: Partial<Record<DevelopmentSection, CriterionDraft[]>> };
type Delivery = { available: boolean; reason: string | null };
type QueueRequest = { executionId: string; attemptId: string; outputId: string; previousIds: string[]; interrupted: boolean };

// These exact API code/status pairs are thrown before reserveEvaluation in
// startEvaluation and its input/auth/identity checks. Generic HTTP failures are not proof.
const evaluationRejectionStatuses = new Map<string, number>([
  ["invalid_input", 400], ["too_large", 413], ["owner_only", 403], ["not_found", 404],
  ["output_not_found", 404], ["invalid_output", 409], ["profile_not_found", 404],
  ["reference_not_found", 404], ["invalid_reference", 422], ["evaluation_too_large", 422],
  ["delivery_unavailable", 503], ["ai_disabled", 409], ["route_unavailable", 409],
]);

/** Retain the server error contract so confirmed rejection differs from response loss. */
class ApiResponseError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiResponseError";
  }
}

/** An older evaluation of the same output cannot resolve a new interrupted request. */
function resolvesRequest(request: QueueRequest, evaluation: Evaluation): boolean {
  return !request.previousIds.includes(evaluation.id) && evaluation.manifest.execution_id === request.executionId && evaluation.manifest.attempt_id === request.attemptId && evaluation.manifest.output_id === request.outputId;
}

/** Preserve unfinished numeric input until the owner explicitly saves the draft. */
function editCriteria(criteria: Criterion[]): CriterionDraft[] {
  return criteria.map((criterion) => ({ ...structuredClone(criterion), weight: String(criterion.weight), threshold: criterion.threshold === undefined ? "" : String(criterion.threshold) }));
}

/** Create a detached editor draft; saved versions and history remain immutable. */
function editProfile(profile: EvaluationProfile): ProfileDraft {
  return { name: profile.name, defaults: editCriteria(profile.defaults), sections: Object.fromEntries(Object.entries(profile.sections).map(([section, criteria]) => [section, editCriteria(criteria)])) };
}

/** Convert numeric text only at validation time; empty required weights fail closed. */
function profilePayload(draft: ProfileDraft) {
  const criteria = (items: CriterionDraft[]) => items.map(({ weight, threshold, ...item }) => ({ ...item, weight: weight.trim() === "" ? Number.NaN : Number(weight), ...(threshold.trim() === "" ? {} : { threshold: Number(threshold) }) }));
  return { name: draft.name, defaults: criteria(draft.defaults), sections: Object.fromEntries(Object.entries(draft.sections).map(([section, items]) => [section, criteria(items)])) };
}

/** Decode owner-facing API failures without discarding their recovery guidance. */
async function requestJson<T>(url: string, signal: AbortSignal, payload?: unknown): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store", ...(payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) });
  const body = await response.json();
  if (!response.ok) throw new ApiResponseError(response.status, typeof body.code === "string" ? body.code : "", typeof body.error === "string" ? body.error : "Unable to read evaluation data. Reload evaluation data before retrying.");
  return body as T;
}

/** Edit a single criterion with explicit five-level scoring anchors. */
function CriterionFields({ value, index, onChange, onRemove }: { value: CriterionDraft; index: number; onChange: (value: CriterionDraft) => void; onRemove: () => void }) {
  return <fieldset aria-label={`Criterion ${index + 1}`} className="min-w-0 space-y-3 border-t border-border pt-3">
    <legend className="font-medium">{value.name || `Criterion ${index + 1}`}</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block space-y-1">Criterion ID<Input value={value.id} onChange={(event) => onChange({ ...value, id: event.target.value })} /></label>
      <label className="block space-y-1">Name<Input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
      <label className="block space-y-1 sm:col-span-2">Definition<textarea className={textClass} value={value.definition} onChange={(event) => onChange({ ...value, definition: event.target.value })} /></label>
      <label className="block space-y-1 sm:col-span-2">Instructions<textarea className={textClass} value={value.instructions} onChange={(event) => onChange({ ...value, instructions: event.target.value })} /></label>
      <label className="block space-y-1">Weight<Input type="number" min="0" max="1000" step="any" value={value.weight} onChange={(event) => onChange({ ...value, weight: event.target.value })} /></label>
      <label className="block space-y-1">Threshold (optional)<Input type="number" min="0" max="4" step="any" value={value.threshold} onChange={(event) => onChange({ ...value, threshold: event.target.value })} /></label>
      {anchors.map((anchor) => <label key={anchor} className="block space-y-1 sm:col-span-2">Anchor {anchor}<textarea className={textClass} value={value.anchors[anchor]} onChange={(event) => onChange({ ...value, anchors: { ...value.anchors, [anchor]: event.target.value } })} /></label>)}
    </div>
    <Button variant="outline" onClick={onRemove}>Remove criterion {index + 1}</Button>
  </fieldset>;
}

/** Show original and parsed identities without presenting provisional references as reviewed. */
function DocumentIdentity({ document, kind }: { document: DevelopmentDocument; kind: "Source" | "Reference" }) {
  return <p className="break-all">{kind} snapshot: {document.filename} · {document.id} · {document.review_status} · {document.compatibility}<br />Original SHA-256: {document.sha256}<br />Parsed SHA-256: {document.parsed_sha256}</p>;
}

/** Keep empty denominators unscored instead of assigning an invented perfect value. */
function ratioText(measure: RatioMeasure): string {
  return measure.value === null ? `unscored (${measure.numerator}/${measure.denominator})` : `${measure.numerator}/${measure.denominator} (${(measure.value * 100).toFixed(1)}%)`;
}

// Presentation validation rejects missing legacy evidence rather than filling invented scores.
const ratioView = z.object({ numerator: z.number().finite(), denominator: z.number().finite(), value: z.number().finite().nullable() });
const evaluationView = z.object({
  status: z.string(), error: z.string().nullable(),
  manifest: z.object({ section: z.string(), execution_id: z.string(), attempt_id: z.string(), output_id: z.string(), profile: z.object({ id: z.string(), name: z.string(), version: z.number() }),
    config: z.object({ sections: z.record(z.string(), z.object({ method: z.string(), route: z.object({ provider_id: z.string(), model: z.string() }) })) }),
    route: z.object({ actual: z.object({ provider_id: z.string(), model: z.string(), reason: z.string().nullable().optional() }) }).nullable(),
    criteria: z.array(z.object({ id: z.string(), name: z.string() })),
    sources: z.array(z.object({ id: z.string(), filename: z.string(), review_status: z.string(), compatibility: z.string(), sha256: z.string(), parsed_sha256: z.string().nullable() })),
    references: z.array(z.object({ id: z.string(), filename: z.string(), review_status: z.string(), compatibility: z.string(), sha256: z.string(), parsed_sha256: z.string().nullable() })),
  }),
  result: z.object({ checks: z.object({ passed: z.boolean(), items: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string() })) }),
    rubric: z.object({ score: z.number().finite(), criteria: z.array(z.object({ criterion_id: z.string(), score: z.number().finite(), reason: z.string(), threshold_met: z.boolean().nullable() })) }).nullable(),
    reference: z.object({ status: z.string(), reasons: z.array(z.string()), precision: ratioView, recall: ratioView, matches: z.array(z.object({ output_id: z.string(), reference_id: z.string(), reason: z.string() })), unmatched_output_ids: z.array(z.string()), unmatched_reference_ids: z.array(z.string()) }),
  }).nullable(),
});

/** Render frozen evidence and the three independent result categories. */
export function EvaluationDetail({ evaluation }: { evaluation: Evaluation }) {
  if (!evaluationView.safeParse(evaluation).success || !evaluation.manifest.config.sections[evaluation.manifest.section]) return <div className="space-y-2"><p>Evaluation evidence unavailable: incomplete or malformed saved metadata.</p><details><summary>Retained evaluation content</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(evaluation, null, 2)}</pre></details></div>;
  const { manifest, result } = evaluation;
  const settings = manifest.config.sections[manifest.section];
  return <div className="min-w-0 space-y-3 break-words" aria-live="polite">
    <p className="font-medium">Evaluation status: {evaluation.status}</p>
    <p className="break-all">Evaluation ID: {evaluation.id}<br />Frozen profile: {manifest.profile.name} · {manifest.profile.id}@{manifest.profile.version}<br />Frozen output: {manifest.output_id}<br />Execution: {manifest.execution_id} · Attempt: {manifest.attempt_id} · {labels[manifest.section]}</p>
    <p>Frozen method: {settings.method} · Requested evaluator: {settings.route.provider_id} / {settings.route.model}</p>
    {manifest.route && <p>Resolved evaluator: {manifest.route.actual.provider_id} / {manifest.route.actual.model}{manifest.route.actual.reason ? ` · ${manifest.route.actual.reason}` : ""}</p>}
    {manifest.sources.map((document) => <DocumentIdentity key={document.id} document={document} kind="Source" />)}
    {manifest.references.map((document) => <DocumentIdentity key={document.id} document={document} kind="Reference" />)}
    {!manifest.references.length && <p>Frozen references: none selected.</p>}
    {activeStatuses.has(evaluation.status) && <p>Waiting for durable worker progress. This page polls saved state; it does not dispatch provider calls.</p>}
    {evaluation.error && <p role="alert" className="text-destructive">{evaluation.error}</p>}
    {(evaluation.status === "needs_attention" || evaluation.status === "failed") && <p>No automatic resend. Inspect the retained receipt before explicitly requesting a fresh evaluation, which may incur provider charges.</p>}
    {result && <>
      <section aria-label="Factual checks" className="space-y-2 border-t border-border pt-3">
        <h4 className="font-medium">Factual checks: {result.checks.passed ? "passed" : "failed"}</h4>
        <p>Deterministic validity checks remain independent of rubric scores.</p>
        <ul className="space-y-1">{result.checks.items.map((check) => <li key={check.id}>{check.id}: {check.passed ? "passed" : "failed"} · {check.detail}</li>)}</ul>
      </section>
      <section aria-label="Provisional AI assessment" className="space-y-2 border-t border-border pt-3">
        <h4 className="font-medium">{result.rubric ? `Provisional AI assessment: ${result.rubric.score.toFixed(2)} / 4` : "Provisional AI assessment: not requested"}</h4>
        <p>A custom score cannot override failed factual checks or establish human approval.</p>
        {result.rubric && <ul className="space-y-2">{result.rubric.criteria.map((criterion) => <li key={criterion.criterion_id}>{manifest.criteria.find((item) => item.id === criterion.criterion_id)?.name ?? criterion.criterion_id}: {criterion.score} / 4 · {criterion.reason}{criterion.threshold_met !== null ? ` · Threshold ${criterion.threshold_met ? "met" : "not met"}` : ""}</li>)}</ul>}
      </section>
      <section aria-label="Provisional reference measures" className="space-y-2 border-t border-border pt-3">
        <h4 className="font-medium">Provisional reference measures: {result.reference.status}</h4>
        <p>Precision: {ratioText(result.reference.precision)} · matched output items / all output items</p>
        <p>Recall: {ratioText(result.reference.recall)} · matched expected answers / all expected answers</p>
        {result.reference.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
        <p>Semantic matches are provisional judgments, including when reference review status changes. These measures are not pipeline accuracy.</p>
        <details><summary className="cursor-pointer">Reference matching judgments</summary><div className="space-y-2 pt-2">{result.reference.matches.map((match) => <p key={`${match.output_id}:${match.reference_id}`} className="break-all">{match.output_id} → {match.reference_id}: {match.reason}</p>)}<p className="break-all">Unmatched output IDs: {result.reference.unmatched_output_ids.join(", ") || "none"}</p><p className="break-all">Unmatched expected answer IDs: {result.reference.unmatched_reference_ids.join(", ") || "none"}</p></div></details>
      </section>
    </>}
    <details><summary className="cursor-pointer">Frozen profile, configuration and output</summary><pre className="overflow-x-auto whitespace-pre-wrap break-all pt-2 text-xs">{JSON.stringify({ profile: manifest.profile, config: manifest.config, output: manifest.output }, null, 2)}</pre></details>
    <details><summary className="cursor-pointer">Evaluator receipt, trace and usage</summary><pre className="overflow-x-auto whitespace-pre-wrap break-all pt-2 text-xs">{JSON.stringify({ receipt: evaluation.receipt, failure_accounting: evaluation.failure_accounting }, null, 2)}</pre></details>
  </div>;
}

/** Configure evaluations without regenerating or rewriting historical outputs and scores. */
export function DevelopmentEvaluation({ draft, execution, providers, disabled, onHistoryChange }: { draft: Experiment; execution?: Execution; providers: ProviderKeyView[]; disabled: boolean; onHistoryChange: () => void }) {
  const root = `/api/admin/development/${draft.id}`;
  const lifetime = useRef<AbortController | null>(null);
  const [profiles, setProfiles] = useState<EvaluationProfile[]>([]);
  const [profileKey, setProfileKey] = useState("");
  const [editor, setEditor] = useState<ProfileDraft | null>(null);
  const [scope, setScope] = useState<DevelopmentSection | "defaults">("defaults");
  const [copy, setCopy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [config, setConfig] = useState<EvaluationConfig>(() => evaluationConfigSchema.parse({}));
  const [history, setHistory] = useState<Evaluation[]>([]);
  const [selected, setSelected] = useState("");
  const [queueRequests, setQueueRequests] = useState<QueueRequest[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const outputs = execution?.sections.filter((attempt) => ["succeeded", "rejected", "not_applicable"].includes(attempt.status) && /^[a-f0-9]{64}$/.test(attempt.result?.output_id ?? "")) ?? [];
  const [attemptId, setAttemptId] = useState(outputs[0]?.id ?? "");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const profile = profiles.find((item) => `${item.id}@${item.version}` === profileKey);
  const attempt = outputs.find((item) => item.id === attemptId) ?? outputs[0];
  const current = history.find((item) => item.id === selected);
  const locked = disabled || pending || loading;
  const historyVersion = history.map((item) => `${item.id}:${item.status}`).join('|');
  useEffect(() => { if (historyVersion) onHistoryChange();
    // Refresh only when durable job identity or status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyVersion]);
  const selectedReferences = references.map((id) => draft.documents.find((item) => item.id === id && item.role === "reference"));
  const comparison = current ? compareEvaluation(current, attempt?.result && profile && !dirty && selectedReferences.every(Boolean) ? { attempt_id: attempt.id, output_id: attempt.result.output_id, profile, config, references: selectedReferences as DevelopmentDocument[] } : null) : null;

  // The editor belongs to the experiment; only output-bound actions reset on execution changes.
  const executionId = execution?.id ?? "";
  const [previousExecutionId, setPreviousExecutionId] = useState(executionId);
  if (previousExecutionId !== executionId) {
    setPreviousExecutionId(executionId);
    setAttemptId(""); setReferences([]); setPending(false); setError(""); setMessage("");
  }
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [root, executionId]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [savedProfiles, savedEvaluations] = await Promise.all([
          requestJson<{ profiles: EvaluationProfile[] }>(`${root}/profiles`, controller.signal),
          requestJson<{ evaluations: Evaluation[]; delivery: Delivery }>(`${root}/evaluations`, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        const initial = savedProfiles.profiles.find((item) => item.id === "balanced") ?? savedProfiles.profiles[0];
        if (!initial) throw new Error("No evaluation profile is available. Reload evaluation data.");
        setProfiles(savedProfiles.profiles); setProfileKey(`${initial.id}@${initial.version}`); setEditor(editProfile(initial));
        setHistory(savedEvaluations.evaluations); setSelected(savedEvaluations.evaluations[0]?.id ?? ""); setDelivery(savedEvaluations.delivery);
      } catch (failure) { if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "Unable to load evaluation data."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [root]);

  // Poll every active retained attempt, even while a different historical record is open.
  const activeEvaluationIds = JSON.stringify(history.filter((item) => activeStatuses.has(item.status)).map((item) => item.id).sort());
  useEffect(() => {
    const ids = JSON.parse(activeEvaluationIds) as string[];
    if (!ids.length) return;
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      await Promise.all(ids.map(async (id) => {
        try {
          const body = await requestJson<{ evaluation: Evaluation }>(`${root}/evaluations/${id}`, controller.signal);
          if (!controller.signal.aborted) setHistory((items) => items.map((item) => item.id === id ? body.evaluation : item));
        } catch (failure) {
          if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to refresh evaluation. Reload evaluation data.");
        }
      }));
      // A failed read must not stop progress tracking or resend any evaluation work.
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 3000);
    }
    timer = window.setTimeout(() => void poll(), 3000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [root, activeEvaluationIds]);

  // Aborting a browser POST does not cancel a durable server write. Recover independently
  // of execution selection, retaining its exact-output lock if history fails or is premature.
  const interruptedRequests = JSON.stringify(queueRequests.filter((request) => request.interrupted));
  useEffect(() => {
    if (interruptedRequests === "[]") return;
    const controller = new AbortController();
    async function reconcile() {
      try {
        const saved = await requestJson<{ evaluations: Evaluation[]; delivery: Delivery }>(`${root}/evaluations`, controller.signal);
        if (controller.signal.aborted) return;
        setHistory((items) => [...saved.evaluations, ...items.filter((item) => !saved.evaluations.some((record) => record.id === item.id))]);
        setSelected((id) => id || saved.evaluations[0]?.id || "");
        setDelivery(saved.delivery);
        setQueueRequests((items) => items.filter((request) => !request.interrupted || !saved.evaluations.some((record) => resolvesRequest(request, record))));
      } catch (failure) {
        if (!controller.signal.aborted) setError(`${failure instanceof Error ? failure.message : "Unable to recover saved evaluation history."} The original output remains locked. Reload evaluation data to check again.`);
      }
    }
    void reconcile();
    return () => controller.abort();
  }, [root, interruptedRequests]);

  /** Refresh authoritative history after a conflict or an uncertain client response. */
  async function reload() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setPending(true); setError(""); setLoadError("");
    try {
      const [savedProfiles, savedEvaluations] = await Promise.all([
        requestJson<{ profiles: EvaluationProfile[] }>(`${root}/profiles`, signal),
        requestJson<{ evaluations: Evaluation[]; delivery: Delivery }>(`${root}/evaluations`, signal),
      ]);
      if (signal.aborted) return;
      const available = savedProfiles.profiles.find((item) => `${item.id}@${item.version}` === profileKey);
      if (!available) {
        const initial = savedProfiles.profiles.find((item) => item.id === "balanced") ?? savedProfiles.profiles[0];
        if (!initial) throw new Error("No evaluation profile is available. Reload evaluation data.");
        setProfileKey(`${initial.id}@${initial.version}`); setEditor(editProfile(initial)); setCopy(false); setDirty(false);
      }
      setProfiles(savedProfiles.profiles); setHistory(savedEvaluations.evaluations); setDelivery(savedEvaluations.delivery);
      setQueueRequests((items) => items.filter((request) => !request.interrupted || !savedEvaluations.evaluations.some((record) => resolvesRequest(request, record))));
      setSelected((id) => savedEvaluations.evaluations.some((item) => item.id === id) ? id : savedEvaluations.evaluations[0]?.id ?? "");
      setMessage("Evaluation data reloaded. Select a saved profile version to replace an edited draft.");
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to reload evaluation data."); }
    finally { if (!signal.aborted) setPending(false); }
  }

  /** Publish a new immutable version after validating all draft fields together. */
  async function saveProfile() {
    const signal = lifetime.current?.signal;
    if (!editor || !profile || !signal || signal.aborted || locked) return;
    const input = profileInputSchema.safeParse({ ...profilePayload(editor), ...(!copy ? { profile_id: profile.id, base_version: profile.version } : {}) });
    if (!input.success) { setError(input.error.issues.map((issue) => `${issue.path.join(".") || "Profile"}: ${issue.message}`).join("; ")); return; }
    setPending(true); setError(""); setMessage("");
    try {
      const body = await requestJson<{ profile: EvaluationProfile }>(`${root}/profiles`, signal, input.data);
      if (signal.aborted) return;
      setProfiles((items) => [...items, body.profile]); setProfileKey(`${body.profile.id}@${body.profile.version}`); setEditor(editProfile(body.profile)); setCopy(false); setDirty(false);
      setMessage(`Saved ${body.profile.name} version ${body.profile.version}. Earlier versions remain unchanged.`);
    } catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to save profile. Reload evaluation data before retrying."); }
    finally { if (!signal.aborted) setPending(false); }
  }

  /** Queue an exact persisted output binding; this action never invokes generation. */
  async function evaluate() {
    const signal = lifetime.current?.signal;
    if (!execution || !attempt?.result || !profile || !signal || signal.aborted || locked || dirty || !delivery?.available || activeForOutput || requestForOutput || attempt.status === "not_applicable") return;
    const input = startEvaluationSchema.safeParse({ execution_id: execution.id, attempt_id: attempt.id, output_id: attempt.result.output_id, section: attempt.section, profile_id: profile.id, profile_version: profile.version, reference_ids: references, config });
    if (!input.success) { setError(input.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    const submission: QueueRequest = { executionId: execution.id, attemptId: attempt.id, outputId: attempt.result.output_id, previousIds: history.map((item) => item.id), interrupted: false };
    setQueueRequests((items) => [...items, submission]);
    setPending(true); setError(""); setMessage("");
    try {
      const body = await requestJson<{ evaluation: Evaluation }>(`${root}/evaluations`, signal, input.data);
      if (signal.aborted) return;
      setQueueRequests((items) => items.filter((item) => item !== submission));
      setHistory((items) => [body.evaluation, ...items]); setSelected(body.evaluation.id); setMessage("Evaluation queued for the saved output. Generation was not requested.");
    } catch (failure) {
      const rejected = failure instanceof ApiResponseError && evaluationRejectionStatuses.get(failure.code) === failure.status;
      if (rejected) setQueueRequests((items) => items.filter((item) => item !== submission));
      else setQueueRequests((items) => items.map((item) => item === submission ? { ...item, interrupted: true } : item));
      if (!signal.aborted) setError(`${failure instanceof Error ? failure.message : "Unable to queue evaluation."} ${rejected ? "No evaluation was queued. Correct the selection or settings, then explicitly try again." : "Checking saved history before another evaluation can be requested."}`);
    }
    finally {
      if (signal.aborted) setQueueRequests((items) => items.map((item) => item === submission ? { ...item, interrupted: true } : item));
      else setPending(false);
    }
  }

  const latestProfiles = profiles.filter((item) => !profiles.some((other) => other.id === item.id && other.version > item.version));
  const readOnly = !!profile?.builtin && !copy;
  const criteria = editor ? scope === "defaults" ? editor.defaults : editor.sections[scope] ?? editor.defaults : [];
  const hasOverride = scope !== "defaults" && !!editor?.sections[scope];
  const hasEvaluation = history.some((item) => item.manifest.execution_id === execution?.id && item.manifest.attempt_id === attempt?.id && item.manifest.output_id === attempt?.result?.output_id);
  const activeForOutput = history.some((item) => activeStatuses.has(item.status) && item.manifest.execution_id === execution?.id && item.manifest.attempt_id === attempt?.id && item.manifest.output_id === attempt?.result?.output_id);

  const requestForOutput = queueRequests.find((request) => request.executionId === execution?.id && request.attemptId === attempt?.id && request.outputId === attempt?.result?.output_id);

  /** Replace only the active criterion list, preserving independent section overrides. */
  function changeCriteria(items: CriterionDraft[]) {
    if (!editor) return;
    setEditor(scope === "defaults" ? { ...editor, defaults: items } : { ...editor, sections: { ...editor.sections, [scope]: items } }); setDirty(true); setError("");
  }

  return <section aria-label="Evaluation" className="min-w-0 space-y-4 border-t border-border pt-5">
    <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">Evaluation</h2><Button variant="outline" disabled={loading || pending} onClick={() => void reload()}>Reload evaluation data</Button></div>
    <p className="max-w-prose text-muted-foreground">Evaluate saved outputs without generation. Factual checks, reference measures and provisional AI assessments are reported separately. A fresh evaluation may incur provider charges.</p>
    {loading && <p role="status">Loading profiles and evaluation history…</p>}
    {loadError && <p role="alert" className="break-words text-destructive">{loadError}</p>}
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    {message && <p role="status">{message}</p>}
    {delivery && !delivery.available && <p>Evaluation delivery unavailable: {delivery.reason ?? "Check server configuration."}</p>}
    {editor && profile && <>
      <fieldset disabled={locked} className="min-w-0 space-y-3">
        <label className="block space-y-1">Saved evaluation profile<select className={routeSelectClass} value={profileKey} onChange={(event) => { const next = profiles.find((item) => `${item.id}@${item.version}` === event.target.value); if (next) { setProfileKey(event.target.value); setEditor(editProfile(next)); setCopy(false); setDirty(false); setError(""); } }}>{latestProfiles.map((item) => <option key={item.id} value={`${item.id}@${item.version}`}>{item.name} · version {item.version}{item.builtin ? " · built-in" : ""}</option>)}{profile && !latestProfiles.includes(profile) && <option value={profileKey}>{profile.name} · version {profile.version} · older version</option>}</select></label>
        <p>{profile.name} · {profile.id}@{profile.version} · {profile.builtin ? "read-only" : "saved version"}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setEditor({ ...editor, name: `${editor.name} copy` }); setCopy(true); setDirty(true); setError(""); }}>Save As custom profile</Button>{dirty && <Button variant="outline" onClick={() => { setEditor(editProfile(profile)); setCopy(false); setDirty(false); setError(""); }}>Discard draft changes</Button>}</div>
        <details><summary className="cursor-pointer font-medium">Profile criteria and anchors</summary><div className="space-y-3 pt-3">
          <p>{readOnly ? "Built-in criteria are immutable. Use Save As custom profile to edit a copy." : "Edits are an unsaved draft until saved as a new version. Evaluations always use a saved version."}</p>
          <fieldset disabled={readOnly} className="min-w-0 space-y-3">
            <label className="block space-y-1">Profile name<Input value={editor.name} onChange={(event) => { setEditor({ ...editor, name: event.target.value }); setDirty(true); }} /></label>
          </fieldset>
          <label className="block space-y-1">Criteria scope<select className={routeSelectClass} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="defaults">Shared defaults</option>{sections.map((section) => <option key={section} value={section}>{labels[section]}</option>)}</select></label>
          <fieldset disabled={readOnly} className="min-w-0 space-y-3">
            {scope !== "defaults" && <label className="flex items-center gap-2"><input type="checkbox" checked={hasOverride} onChange={(event) => { const overrides = { ...editor.sections }; if (event.target.checked) overrides[scope] = structuredClone(editor.defaults); else delete overrides[scope]; setEditor({ ...editor, sections: overrides }); setDirty(true); }} />Use section-specific criteria for {labels[scope]}</label>}
            {scope !== "defaults" && !hasOverride && <p>This section inherits the shared defaults. Enable section-specific criteria to replace them.</p>}
            <fieldset disabled={scope !== "defaults" && !hasOverride} className="min-w-0 space-y-4">
              {criteria.map((criterion, index) => <details key={index} open={index === 0}><summary className="cursor-pointer">Criterion {index + 1}: {criterion.name || "Untitled"} · weight {criterion.weight || "missing"}</summary><div className="pt-3"><CriterionFields value={criterion} index={index} onChange={(value) => changeCriteria(criteria.map((item, itemIndex) => itemIndex === index ? value : item))} onRemove={() => changeCriteria(criteria.filter((_, itemIndex) => itemIndex !== index))} /></div></details>)}
              <Button variant="outline" disabled={criteria.length >= 30} onClick={() => changeCriteria([...criteria, { id: "", name: "", definition: "", instructions: "", anchors: { "0": "", "1": "", "2": "", "3": "", "4": "" }, weight: "1", threshold: "" }])}>Add criterion</Button>
            </fieldset>
          </fieldset>
          <p className="text-muted-foreground">Each list needs 1–30 criteria, unique IDs and names, all five anchors, weights from 0 to 1000 with positive total weight, and optional thresholds from 0 to 4.</p>
          {!readOnly && <Button disabled={!dirty} onClick={() => void saveProfile()}>{copy ? "Save new profile" : "Save new version"}</Button>}
        </div></details>
        <details className="border-t border-border pt-3"><summary className="cursor-pointer font-medium">Per-section evaluator settings</summary><div className="space-y-4 pt-3">{sections.map((section) => <fieldset key={section} aria-label={`${labels[section]} evaluator`} className="min-w-0 space-y-3 border-t border-border pt-3"><legend className="font-medium">{labels[section]}</legend><label className="block space-y-1">Method<select className={routeSelectClass} value={config.sections[section].method} onChange={(event) => setConfig({ ...config, sections: { ...config.sections, [section]: { ...config.sections[section], method: event.target.value as EvaluationConfig["sections"][DevelopmentSection]["method"] } } })}><option value="checks_only">Factual checks only</option><option value="rubric">Factual checks + rubric</option><option value="reference">Factual checks + reference comparison</option><option value="rubric_and_reference">Factual checks + rubric + reference comparison</option></select></label><fieldset disabled={config.sections[section].method === "checks_only"}><RouteFields providers={providers} value={config.sections[section].route} onChange={(route) => setConfig({ ...config, sections: { ...config.sections, [section]: { ...config.sections[section], route } } })} /></fieldset></fieldset>)}</div></details>
      </fieldset>
      <fieldset disabled={locked} className="min-w-0 space-y-3 border-t border-border pt-3">
        <legend className="font-medium">Saved output to evaluate</legend>
        {!attempt && <p>Select an execution with a completed retained output. Rejected proposals with saved output can also be evaluated.</p>}
        {attempt && <>
          <label className="block space-y-1">Selected saved output<select className={routeSelectClass} value={attempt.id} onChange={(event) => { setAttemptId(event.target.value); setReferences([]); }}>{outputs.map((item) => <option key={item.id} value={item.id}>{labels[item.section]} · {item.status} · {item.id}</option>)}</select></label>
          <p className="break-all">Execution: {execution?.id} · Attempt: {attempt.id}<br />Selected output SHA-256: {attempt.result?.output_id}<br />Generated output review state: unreviewed · Retained attempt status: {attempt.status}</p>
          <fieldset className="min-w-0 space-y-2"><legend className="font-medium">Reference snapshots (optional, evaluator only)</legend>{draft.documents.filter((document) => document.role === "reference").map((document) => <div key={document.id} className="min-w-0 space-y-1"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" aria-label={`Use ${document.filename} (${document.id})`} checked={references.includes(document.id)} onChange={(event) => setReferences(event.target.checked ? [...references, document.id] : references.filter((id) => id !== document.id))} /><span className="break-all">{document.filename} · {document.section ? labels[document.section] : "No section"} · {document.review_status} · {document.compatibility}</span></label><details><summary className="cursor-pointer">Reference identity: {document.id}</summary><DocumentIdentity document={document} kind="Reference" /></details></div>)}{!draft.documents.some((document) => document.role === "reference") && <p>No reference snapshots. Reference measures will remain unscored.</p>}<p>No reference is selected automatically. Missing or incompatible references remain explicitly unscored; empty denominators are not treated as perfect scores.</p></fieldset>
          {dirty && <p>Save or discard profile draft changes before evaluating.</p>}
          {activeForOutput && <p>An evaluation of this output is still active. Inspect its progress before requesting another.</p>}
          {requestForOutput?.interrupted && <p role="status">The queue request for this output has an uncertain outcome. It remains locked until saved history contains its evaluation. Reload evaluation data to check again; an empty history response does not confirm cancellation.</p>}
          {attempt.status === "not_applicable" && <p>Not applicable: no eligible partial gap. Evaluation is disabled; no quality score is assigned.</p>}
          <Button disabled={dirty || !delivery?.available || activeForOutput || !!requestForOutput || attempt.status === "not_applicable"} onClick={() => void evaluate()}>{hasEvaluation ? "Re-evaluate saved output" : "Evaluate saved output"}</Button>
        </>}
      </fieldset>
    </>}
    <div className="min-w-0 space-y-3 border-t border-border pt-3"><h3 className="font-semibold">Immutable evaluation history</h3><p className="text-muted-foreground">Up to 100 recent attempts. Each record retains its own output, profile version, evaluator settings and reference review state.</p>{!history.length && !loading && <p>No evaluations yet. Choose a saved output above.</p>}{!!history.length && <><label className="block space-y-1">Selected evaluation<select className={routeSelectClass} value={selected} disabled={pending} onChange={(event) => setSelected(event.target.value)}>{history.map((item) => <option key={item.id} value={item.id}>{item.created_at} · {labels[item.manifest.section]} · {item.status} · {item.id}</option>)}</select></label>{current && <><p>Comparison with the selected saved output, profile, section settings and checked references: {comparison?.freshness}{comparison?.reasons.length ? ` · ${comparison.reasons.join(", ")}` : ""}</p><EvaluationDetail evaluation={current} /></>}</>}</div>
  </section>;
}
