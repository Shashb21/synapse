"use client";

/** On-demand immutable complete-proposal inspection in the ledger. */
import { useEffect, useId, useRef, useState } from "react";
import type { Assembly, AssemblyCoverage, ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import type { AssemblyReview } from "@/accuracy/domain/assembly-review";
import type { AssemblyReviewState } from "@/accuracy/store/assembly-review-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type AssemblyListState = { assemblies: Assembly[] } | null;
type AssemblyDetailState = {
  assembly: Assembly;
  reviewState: AssemblyReviewState | null;
  canReview: boolean;
};
type AdvisoryFormState = Record<string, { acknowledged: boolean; reason: string }>;
type ReviewFormState = { rationale: string; advisories: AdvisoryFormState };
type ReviewSubmitState = { assemblyId: string; decision: "approve" | "reject" } | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function simpleValue(value: unknown): string {
  if (value === null || value === undefined) return "None recorded";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "Unsupported value";
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    block_id: "Block",
    external_id: "External ID",
    quote: "Quote",
    quote_block_ids: "Evidence blocks",
    source_file_id: "Source",
    tactic_type: "Tactic type",
  };
  return labels[field] ?? field.replaceAll("_", " ");
}

function StructuredValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>None recorded</span>;
    if (value.every((nested) => !isRecord(nested) && !Array.isArray(nested))) {
      return <span>{value.map(simpleValue).join(", ")}</span>;
    }
    if (value.every(isRecord)) {
      return (
        <ol className="grid gap-2">
          {value.map((row, index) => (
            <li key={index}>
              <dl className="grid gap-1">
                {Object.entries(row).map(([field, nested]) => (
                  <div key={field}>
                    <dt className="inline text-foreground">{fieldLabel(field)}: </dt>
                    <dd className="inline break-words"><StructuredValue value={nested} /></dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      );
    }
    return (
      <ul className="grid gap-1">
        {value.map((nested, index) => <li key={index}><StructuredValue value={nested} /></li>)}
      </ul>
    );
  }
  if (isRecord(value)) {
    return (
      <dl className="grid gap-1">
        {Object.entries(value).map(([field, nested]) => (
          <div key={field}>
            <dt className="inline text-foreground">{fieldLabel(field)}: </dt>
            <dd className="inline break-words"><StructuredValue value={nested} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{simpleValue(value)}</span>;
}

function payloadTitle(item: ResolvedAssemblyItem): string {
  const direct = item.claim_type === "gap" ? item.payload.statement : item.payload.name;
  if (typeof direct === "string" && direct.trim()) return direct;
  const generatedId = item.payload.id;
  return typeof generatedId === "string" && generatedId.trim() ? generatedId : item.id;
}

function coverageOverall(row: AssemblyCoverage): string {
  if (row.output && typeof row.output === "object" && "overall" in row.output) {
    return simpleValue((row.output as { overall?: unknown }).overall);
  }
  return "No structured result";
}

function coverageField(row: AssemblyCoverage, field: string): unknown {
  return isRecord(row.output) ? row.output[field] : null;
}

function mappedGapIds(assembly: Assembly): Set<string> {
  return new Set(assembly.mappings.map((mapping) => mapping.gap_version_id));
}

function statusText(status: Assembly["checks"]["status"]): string {
  return `Deterministic checks ${status}`;
}

function findingKey(finding: { code: string; item_version_ids: string[] }): string {
  return `${finding.code}\u0000${finding.item_version_ids.join("\u0000")}`;
}

function decisionLabel(decision: AssemblyReview["decision"]): string {
  return decision === "approve" ? "Approved" : "Rejected";
}

function reviewStatusText(reviewState: AssemblyReviewState | null): string {
  return reviewState ? `Review status: ${reviewState.status}` : "Review status unavailable";
}

function ListSummary({ assembly }: { assembly: Assembly }) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium text-foreground">{assembly.id}</p>
        <span className="text-[11px] text-[var(--unknown)]">Complete proposal</span>
      </div>
      <p className="text-muted-foreground">
        {statusText(assembly.checks.status)} · {assembly.linking_complete ? "Linking complete" : "Linking incomplete"}
      </p>
      <p className="break-words text-muted-foreground">
        Created: {assembly.created_at} · Sources: {assembly.source_file_ids.join(", ") || "None recorded"}
      </p>
    </div>
  );
}

function Lineage({ item }: { item: ResolvedAssemblyItem }) {
  return (
    <dl className="grid gap-1 text-muted-foreground">
      <div><dt className="inline">Version: </dt><dd className="inline">{item.id}</dd></div>
      <div><dt className="inline">Original claim: </dt><dd className="inline">{item.claim_id}</dd></div>
      <div><dt className="inline">Canonical claim: </dt><dd className="inline">{item.canonical_claim_id}</dd></div>
      <div><dt className="inline">Source: </dt><dd className="inline">{item.source_file_id}</dd></div>
      <div><dt className="inline">Run: </dt><dd className="inline">{item.run_id}</dd></div>
      <div><dt className="inline">Snapshot: </dt><dd className="inline">{item.snapshot_id ?? "Judged final output (no snapshot)"}</dd></div>
      <div><dt className="inline">Iteration: </dt><dd className="inline">{item.iteration ?? "Judged final output"}</dd></div>
      <div><dt className="inline">Item index: </dt><dd className="inline">{item.item_index}</dd></div>
      <div><dt className="inline">Selection reason: </dt><dd className="inline">{item.reason}</dd></div>
    </dl>
  );
}

function SelectedItem({ item }: { item: ResolvedAssemblyItem }) {
  return (
    <li className="border-b border-border pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{payloadTitle(item)}</p>
        <Badge variant="secondary" className="text-[10px]">{item.claim_type}</Badge>
      </div>
      <Lineage item={item} />
      <dl className="mt-2 grid gap-1">
        {Object.entries(item.payload).map(([field, value]) => (
          <div key={field}>
            <dt className="font-medium">{fieldLabel(field)}</dt>
            <dd className="break-words text-muted-foreground"><StructuredValue value={value} /></dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

function ReviewDecision({ decision }: { decision: AssemblyReview }) {
  const advisoryOverrides = decision.advisory_overrides ?? [];
  return (
    <section className="grid gap-2" aria-label="Latest review decision">
      <p className="font-medium">Latest review decision</p>
      <dl className="grid gap-1 text-muted-foreground">
        <div><dt className="inline">Decision: </dt><dd className="inline">{decisionLabel(decision.decision)}</dd></div>
        <div><dt className="inline">Reviewer: </dt><dd className="inline">{decision.reviewer_actor_name} ({decision.reviewer_actor_function})</dd></div>
        <div><dt className="inline">Reviewer role: </dt><dd className="inline">{decision.reviewer_role}</dd></div>
        <div><dt className="inline">Reviewed at: </dt><dd className="inline">{decision.created_at}</dd></div>
        <div><dt className="inline">Rationale: </dt><dd className="inline">{decision.rationale}</dd></div>
      </dl>
      {advisoryOverrides.length > 0 ? (
        <ul className="grid gap-1 text-muted-foreground">
          {advisoryOverrides.map((override) => (
            <li key={`${override.code}:${override.item_version_ids.join(":")}`}>
              Advisory {override.code}: {override.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {decision.decision === "reject" ? (
        <p className="text-muted-foreground">
          Live use pauses until a revised complete proposal is generated and approved.
        </p>
      ) : null}
    </section>
  );
}

function ReviewControls({
  assembly,
  reviewState,
  canReview,
  form,
  submitting,
  error,
  onFormChange,
  onSubmit,
  onRefresh,
}: {
  assembly: Assembly;
  reviewState: AssemblyReviewState | null;
  canReview: boolean;
  form: ReviewFormState;
  submitting: ReviewSubmitState;
  error: string | null;
  onFormChange: (form: ReviewFormState) => void;
  onSubmit: (decision: "approve" | "reject") => void;
  onRefresh: () => void;
}) {
  const rationale = form.rationale.trim();
  const findings = reviewState?.checks.findings ?? assembly.checks.findings;
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const advisories = findings.filter((finding) => finding.severity === "advisory");
  const advisoryComplete = advisories.every((finding) => {
    const state = form.advisories[findingKey(finding)];
    return state?.acknowledged && state.reason.trim();
  });
  const currentPending = reviewState?.status === "pending" && reviewState.head_status === "current";
  const busy = submitting !== null;
  const submittingThis = submitting?.assemblyId === assembly.id;
  const approveDisabled = busy || !canReview || !currentPending || !rationale || blocking.length > 0 || !advisoryComplete;
  const rejectDisabled = busy || !canReview || !currentPending || !rationale || !advisoryComplete;
  const setRationale = (value: string) => onFormChange({ ...form, rationale: value });

  if (!reviewState) return <p className="text-muted-foreground">Review metadata was not returned for this proposal.</p>;
  if (!canReview) {
    return (
      <p className="text-muted-foreground">
        You can inspect this proposal, but your current role cannot approve or reject it.
      </p>
    );
  }
  if (reviewState.status !== "pending" || reviewState.head_status !== "current") {
    return (
      <div className="grid gap-2">
        {reviewState.status === "stale" || reviewState.head_status === "stale" ? (
          <p className="text-muted-foreground">Refresh proposal before deciding.</p>
        ) : (
          <p className="text-muted-foreground">This proposal already has an immutable review decision.</p>
        )}
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}>Refresh proposal</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="grid gap-3" onSubmit={(event) => event.preventDefault()} aria-label="Review proposal">
      {blocking.length > 0 ? (
        <p className="text-muted-foreground">Blocking findings must be fixed before this proposal can be approved.</p>
      ) : null}
      <label className="grid gap-1">
        <span className="font-medium">Review rationale</span>
        <textarea
          className="min-h-20 border border-border bg-background p-2 text-foreground"
          value={form.rationale}
          disabled={submittingThis}
          required
          onInput={(event) => setRationale(event.currentTarget.value)}
          onChange={(event) => setRationale(event.currentTarget.value)}
        />
      </label>
      {advisories.length > 0 ? (
        <div className="grid gap-2" aria-label="Advisory acknowledgements">
          {advisories.map((finding) => {
            const key = findingKey(finding);
            const advisory = form.advisories[key] ?? { acknowledged: false, reason: "" };
            const setAcknowledged = (acknowledged: boolean) => onFormChange({
              ...form,
              advisories: {
                ...form.advisories,
                [key]: { ...advisory, acknowledged },
              },
            });
            const setReason = (reason: string) => onFormChange({
              ...form,
              advisories: {
                ...form.advisories,
                [key]: { ...advisory, reason },
              },
            });
            return (
              <div key={key} className="grid gap-2 border border-border p-2">
                <p className="font-medium">{finding.code}</p>
                <p className="text-muted-foreground">{finding.message}</p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={advisory.acknowledged}
                    disabled={submittingThis}
                    onInput={(event) => setAcknowledged(event.currentTarget.checked)}
                    onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                  />
                  <span>Acknowledge advisory {finding.code}</span>
                </label>
                <label className="grid gap-1">
                  <span>Reason for advisory {finding.code}</span>
                  <input
                    className="border border-border bg-background p-2 text-foreground"
                    value={advisory.reason}
                    disabled={submittingThis}
                    required
                    onInput={(event) => setReason(event.currentTarget.value)}
                    onChange={(event) => setReason(event.currentTarget.value)}
                  />
                </label>
              </div>
            );
          })}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="grid gap-2 text-destructive">
          <p>{error} Refresh proposal before trying again.</p>
          <div>
            <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}>Refresh proposal</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          aria-label="Approve proposal"
          disabled={approveDisabled}
          onClick={() => onSubmit("approve")}
        >
          {submitting?.assemblyId === assembly.id && submitting.decision === "approve" ? "Approving..." : "Approve proposal"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label="Reject proposal"
          disabled={rejectDisabled}
          onClick={() => onSubmit("reject")}
        >
          {submitting?.assemblyId === assembly.id && submitting.decision === "reject" ? "Rejecting..." : "Reject proposal"}
        </Button>
      </div>
    </form>
  );
}

function AssemblyDetail({
  assembly,
  reviewState,
  canReview,
  form,
  submitting,
  reviewError,
  onFormChange,
  onReview,
  onRefresh,
}: {
  assembly: Assembly;
  reviewState: AssemblyReviewState | null;
  canReview: boolean;
  form: ReviewFormState;
  submitting: ReviewSubmitState;
  reviewError: string | null;
  onFormChange: (form: ReviewFormState) => void;
  onReview: (decision: "approve" | "reject") => void;
  onRefresh: () => void;
}) {
  const selectedMappedGapIds = mappedGapIds(assembly);
  const gaps = assembly.items.filter((item) => item.claim_type === "gap");
  const uncovered = gaps.filter((gap) => !selectedMappedGapIds.has(gap.id));

  return (
    <div className="mt-3 grid gap-4 border-t border-border pt-3">
      <section className="grid gap-1" aria-label={`Proposal identity ${assembly.id}`}>
        <p className="font-medium">{reviewStatusText(reviewState)}</p>
        {reviewState ? <p className="text-muted-foreground">Live head: {reviewState.head_status}</p> : null}
        <p className="break-words text-muted-foreground">Fingerprint: {assembly.fingerprint}</p>
        <p className="break-words text-muted-foreground">Source scope: {assembly.source_file_ids.join(", ") || "None recorded"}</p>
        <p className="break-words text-muted-foreground">
          Extraction scope: {assembly.extraction_runs
            ? assembly.extraction_runs.map(run => `${run.call_kind} ${run.run_id} ${run.outcome} (${run.item_count})`).join(", ") || "Requested extractors returned no rows"
            : "Unknown for this proposal"}
        </p>
        <p className="text-muted-foreground">Actor: {assembly.actor.name} ({assembly.actor.function})</p>
        <p className="text-muted-foreground">{assembly.linking_complete ? "Linking complete" : "Linking incomplete"}</p>
      </section>

      {reviewState?.latest_decision ? <ReviewDecision decision={reviewState.latest_decision} /> : null}

      <section className="grid gap-2" aria-label="Review controls">
        <p className="font-medium">Review decision</p>
        <ReviewControls
          assembly={assembly}
          reviewState={reviewState}
          canReview={canReview}
          form={form}
          submitting={submitting}
          error={reviewError}
          onFormChange={onFormChange}
          onSubmit={onReview}
          onRefresh={onRefresh}
        />
      </section>

      <section className="grid gap-2" aria-label="Selected generated items">
        <p className="font-medium">Selected generated items</p>
        {assembly.items.length === 0 ? (
          <p className="text-muted-foreground">No generated gaps or tactics were selected.</p>
        ) : (
          <ol className="grid gap-3">
            {assembly.items.map((item) => <SelectedItem key={item.id} item={item} />)}
          </ol>
        )}
      </section>

      <section className="grid gap-2" aria-label="Mappings and uncovered gaps">
        <p className="font-medium">Mappings and uncovered gaps</p>
        {assembly.mappings.length === 0 ? (
          <p className="text-muted-foreground">No supported mappings recorded.</p>
        ) : (
          <ul className="grid gap-1">
            {assembly.mappings.map((mapping) => (
              <li key={`${mapping.gap_version_id}:${mapping.tactic_version_id}`}>
                Mapping: {mapping.gap_version_id} -&gt; {mapping.tactic_version_id}
              </li>
            ))}
          </ul>
        )}
        {uncovered.length === 0 ? (
          <p className="text-muted-foreground">No uncovered selected gaps.</p>
        ) : (
          <ul className="grid gap-1">
            {uncovered.map((gap) => <li key={gap.id}>Uncovered gap: {gap.id}</li>)}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-label="Coverage outcomes">
        <p className="font-medium">Coverage outcomes</p>
        {assembly.coverage.length === 0 ? (
          <p className="text-muted-foreground">No coverage outcomes recorded.</p>
        ) : (
          <ul className="grid gap-2">
            {assembly.coverage.map((row) => (
              <li key={`${row.run_id}:${row.gap_version_id}:${row.tactic_version_id}`} className="border-b border-border pb-2">
                <p>{row.gap_version_id} -&gt; {row.tactic_version_id} · {coverageOverall(row)}</p>
                <p className="text-muted-foreground">Run: {row.run_id} · Mode: {row.mode}</p>
                {row.mode === "stub" ? <p className="text-[var(--unknown)]">Stub coverage advisory</p> : null}
                {isRecord(row.output) && "quote_block_ids" in row.output ? (
                  <p className="text-muted-foreground">Evidence blocks: <StructuredValue value={coverageField(row, "quote_block_ids")} /></p>
                ) : null}
                {isRecord(row.output) && "rationale" in row.output ? (
                  <p className="text-muted-foreground">Rationale: <StructuredValue value={coverageField(row, "rationale")} /></p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-label="Deterministic check findings">
        <p className="font-medium">{statusText(assembly.checks.status)}</p>
        <p className="text-muted-foreground">Checker: {assembly.checks.checker_version}</p>
        {assembly.checks.findings.length === 0 ? (
          <p className="text-muted-foreground">No deterministic findings.</p>
        ) : (
          <ul className="grid gap-2">
            {assembly.checks.findings.map((finding) => (
              <li key={`${finding.code}:${finding.item_version_ids.join(":")}:${finding.message}`} className="border-b border-border pb-2">
                <p className="font-medium">{finding.code} · {finding.severity}</p>
                <p>{finding.message}</p>
                <p className="text-muted-foreground">Items: {finding.item_version_ids.join(", ") || "Whole assembly"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Render saved complete proposals and their server-bound review controls. */
export function AssemblyHistory({ workspaceId }: { workspaceId: string }) {
  return <AssemblyHistoryPanel key={workspaceId} workspaceId={workspaceId} />;
}

function AssemblyHistoryPanel({ workspaceId }: { workspaceId: string }) {
  const listPanelId = useId();
  const listRequestToken = useRef(0);
  const detailRequestToken = useRef(0);
  const reviewRequestToken = useRef(0);
  const reviewInFlight = useRef(false);
  const mounted = useRef(true);
  const [expanded, setExpanded] = useState(false);
  const [list, setList] = useState<AssemblyListState>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [openAssemblyId, setOpenAssemblyId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, AssemblyDetailState>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const [reviewForms, setReviewForms] = useState<Record<string, ReviewFormState>>({});
  const [reviewSubmitting, setReviewSubmitting] = useState<ReviewSubmitState>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listRequestToken.current += 1;
      detailRequestToken.current += 1;
      reviewRequestToken.current += 1;
      reviewInFlight.current = false;
    };
  }, []);

  async function loadList() {
    const token = listRequestToken.current + 1;
    listRequestToken.current = token;
    setListLoading(true);
    setListError(null);
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId });
      const response = await fetch(`/api/accuracy/assemblies?${query}`, { cache: "no-store" });
      const body = await response.json() as { assemblies?: Assembly[]; error?: string };
      if (!mounted.current || token !== listRequestToken.current) return;
      if (!response.ok) throw new Error(body.error ?? "Could not load complete proposals");
      setList({ assemblies: body.assemblies ?? [] });
    } catch (cause) {
      if (!mounted.current || token !== listRequestToken.current) return;
      setListError(cause instanceof Error ? cause.message : "Could not load complete proposals");
    } finally {
      if (mounted.current && token === listRequestToken.current) setListLoading(false);
    }
  }

  async function loadDetail(assemblyId: string) {
    const token = detailRequestToken.current + 1;
    detailRequestToken.current = token;
    setDetailLoading(assemblyId);
    setDetails((current) => {
      const next = { ...current };
      delete next[assemblyId];
      return next;
    });
    setDetailError((current) => ({ ...current, [assemblyId]: "" }));
    setReviewErrors((current) => ({ ...current, [assemblyId]: "" }));
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId, assembly_id: assemblyId });
      const response = await fetch(`/api/accuracy/assemblies?${query}`, { cache: "no-store" });
      const body = await response.json() as { assembly?: Assembly; review_state?: AssemblyReviewState; can_review?: boolean; error?: string };
      if (!mounted.current || token !== detailRequestToken.current) return;
      if (!response.ok || !body.assembly) throw new Error(body.error ?? "Could not load proposal");
      setDetails((current) => ({
        ...current,
        [assemblyId]: {
          assembly: body.assembly!,
          reviewState: body.review_state ?? null,
          canReview: Boolean(body.can_review),
        },
      }));
    } catch (cause) {
      if (!mounted.current || token !== detailRequestToken.current) return;
      setDetailError((current) => ({ ...current, [assemblyId]: cause instanceof Error ? cause.message : "Could not load proposal" }));
    } finally {
      if (mounted.current && token === detailRequestToken.current) setDetailLoading(null);
    }
  }

  function reviewForm(assembly: Assembly, reviewState: AssemblyReviewState | null): ReviewFormState {
    const current = reviewForms[assembly.id];
    const advisories = reviewState?.advisories ?? assembly.checks.findings.filter((finding) => finding.severity === "advisory");
    const advisoryDefaults = Object.fromEntries(advisories.map((finding) => [
      findingKey(finding),
      current?.advisories[findingKey(finding)] ?? { acknowledged: false, reason: "" },
    ]));
    return { rationale: current?.rationale ?? "", advisories: advisoryDefaults };
  }

  async function submitReview(assemblyId: string, decision: "approve" | "reject") {
    const detail = details[assemblyId];
    if (reviewInFlight.current || !detail?.reviewState) return;
    const form = reviewForm(detail.assembly, detail.reviewState);
    const advisory_overrides = (detail.reviewState.advisories ?? []).map((finding) => ({
      code: finding.code,
      item_version_ids: finding.item_version_ids,
      reason: form.advisories[findingKey(finding)]?.reason.trim() ?? "",
    }));
    const token = reviewRequestToken.current + 1;
    reviewRequestToken.current = token;
    reviewInFlight.current = true;
    setReviewSubmitting({ assemblyId, decision });
    setReviewErrors((current) => ({ ...current, [assemblyId]: "" }));
    try {
      const response = await fetch("/api/accuracy/assemblies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          assembly_id: assemblyId,
          expected_fingerprint: detail.assembly.fingerprint,
          expected_review_id: detail.reviewState.expected_review_id,
          decision,
          rationale: form.rationale.trim(),
          advisory_overrides,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!mounted.current || token !== reviewRequestToken.current) return;
      if (!response.ok) throw new Error(body.error ?? "Could not record review decision");
      await loadList();
      if (!mounted.current || token !== reviewRequestToken.current) return;
      await loadDetail(assemblyId);
    } catch (cause) {
      if (!mounted.current || token !== reviewRequestToken.current) return;
      setReviewErrors((current) => ({
        ...current,
        [assemblyId]: cause instanceof Error ? cause.message : "Could not record review decision",
      }));
    } finally {
      if (mounted.current && token === reviewRequestToken.current) {
        reviewInFlight.current = false;
        setReviewSubmitting(null);
      }
    }
  }

  function toggleList() {
    const next = !expanded;
    if (next && !list && !listLoading) void loadList();
    setExpanded(next);
  }

  function toggleDetail(assemblyId: string) {
    const next = openAssemblyId === assemblyId ? null : assemblyId;
    setOpenAssemblyId(next);
    if (next && !details[assemblyId] && detailLoading !== assemblyId) void loadDetail(assemblyId);
  }

  return (
    <section className="mb-6 grid gap-2 text-[12px]" aria-label="Complete assembly proposals">
      <div>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-controls={listPanelId}
          onClick={toggleList}
        >
          Complete proposals
        </Button>
      </div>
      {expanded ? (
        <div id={listPanelId} className="grid gap-3 border-t border-border pt-3">
          {listLoading ? <p role="status">Loading complete proposals…</p> : null}
          {listError ? (
            <div>
              <p role="alert" className="text-destructive">{listError}</p>
              <Button size="sm" variant="outline" disabled={listLoading} onClick={() => void loadList()}>Retry proposals</Button>
            </div>
          ) : null}
          {list && list.assemblies.length === 0 ? (
            <p className="text-muted-foreground">No complete proposals recorded for this workspace.</p>
          ) : null}
          {list && list.assemblies.length > 0 ? (
            <ul className="grid gap-3">
              {list.assemblies.map((assembly) => {
                const detailId = `${listPanelId}-${assembly.id}`;
                const open = openAssemblyId === assembly.id;
                return (
                  <li key={assembly.id} className="border border-border bg-card/40 p-3">
                    <ListSummary assembly={assembly} />
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-expanded={open}
                        aria-controls={detailId}
                        disabled={detailLoading !== null && detailLoading !== assembly.id}
                        onClick={() => toggleDetail(assembly.id)}
                      >
                        Inspect proposal {assembly.id}
                      </Button>
                    </div>
                    {open ? (
                      <div id={detailId}>
                        {detailLoading === assembly.id ? <p role="status" className="mt-2">Loading proposal detail…</p> : null}
                        {detailError[assembly.id] ? (
                          <div className="mt-2">
                            <p role="alert" className="text-destructive">{detailError[assembly.id]}</p>
                            <Button size="sm" variant="outline" disabled={detailLoading !== null} onClick={() => void loadDetail(assembly.id)}>Retry proposal</Button>
                          </div>
                        ) : null}
                        {details[assembly.id] ? (
                          <AssemblyDetail
                            assembly={details[assembly.id].assembly}
                            reviewState={details[assembly.id].reviewState}
                            canReview={details[assembly.id].canReview}
                            form={reviewForm(details[assembly.id].assembly, details[assembly.id].reviewState)}
                            submitting={reviewSubmitting}
                            reviewError={reviewErrors[assembly.id] || null}
                            onFormChange={(form) => setReviewForms((current) => ({ ...current, [assembly.id]: form }))}
                            onReview={(decision) => void submitReview(assembly.id, decision)}
                            onRefresh={() => void loadDetail(assembly.id)}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
