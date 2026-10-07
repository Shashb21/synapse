"use client";

/** Accessible agreement chart/table and an explicit owner action to create a candidate. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgreementBucket } from "@/modules/kernel/learning-agreement";
import type { Actor, StageId } from "@/modules/kernel/contracts";

const STAGES = ["S2", "S3", "S4", "S6", "S8", "S9"] as const;
import type { RevisionEvaluation } from "@/modules/kernel/prompt-revision-evals";
type RevisionMetadata = { id: string; stage: StageId; parent_revision: string; instruction_text?: string; creator: Actor; created_at: string; state: string; training_count: number; heldout_count: number };
export type LearningReport = { bucket: "day" | "week"; agreement: AgreementBucket[]; total: number; date_range: { from: string; to: string } | null; revisions: RevisionMetadata[]; evaluations?: Omit<RevisionEvaluation,"gold_cases">[]; history?: {id:string;stage:string;before_id:string|null;after_id:string|null;action:string;created_at:string;actor:Actor}[] };
const percent = (share: number | null) => share === null ? "—" : `${(share * 100).toFixed(1)}%`;

/** Display UTC periods with counts, an equivalent textual table, and candidate provenance. */
export function LearningConsole({ initial }: { initial: LearningReport }) {
  const [report, setReport] = useState(initial);
  const [stage, setStage] = useState<typeof STAGES[number]>("S2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: string; instruction_text: string } | null>(null);
  const rows = report.agreement.filter(row => row.stage === stage);
  async function load(bucket: "day" | "week") {
    const response = await fetch(`/api/admin/learning?bucket=${bucket}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Learning report could not load.");
    setReport(body);
  }
  async function changeBucket(bucket: "day" | "week") {
    setBusy(true); setError("");
    try { await load(bucket); } catch (err) { setError(err instanceof Error ? err.message : "Learning report could not load."); }
    finally { setBusy(false); }
  }
  async function propose() {
    setBusy(true); setError(""); setCreated(null);
    try {
      const response = await fetch("/api/admin/learning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "propose", stage }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Prompt candidate could not be created.");
      setCreated(body.revision);
      await load(report.bucket);
    } catch (err) { setError(err instanceof Error ? err.message : "Prompt candidate could not be created."); }
    finally { setBusy(false); }
  }
  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try { const response = await fetch("/api/admin/learning", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); const result=await response.json(); if(!response.ok) throw new Error(result.error ?? "Learning action failed."); await load(report.bucket); }
    catch(err) {setError(err instanceof Error ? err.message : "Learning action failed.");} finally {setBusy(false);}
  }
  return <div className="space-y-6" aria-busy={busy}>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <section aria-labelledby="agreement-heading">
      <h2 id="agreement-heading" className="text-base font-semibold">Reviewer agreement</h2>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="learning-summary">
        {report.total} decisions · {report.date_range ? `${report.date_range.from.slice(0, 10)} to ${report.date_range.to.slice(0, 10)} (UTC)` : "No decisions recorded"}
      </p>
      <div className="my-4 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">Stage<select aria-label="Stage" value={stage} onChange={event => setStage(event.target.value as typeof stage)} className="rounded-md border border-input bg-background px-2 py-1">{STAGES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="flex items-center gap-2">Group by<select aria-label="Group by" disabled={busy} value={report.bucket} onChange={event => void changeBucket(event.target.value as "day" | "week")} className="rounded-md border border-input bg-background px-2 py-1"><option value="day">Day</option><option value="week">Week</option></select></label>
      </div>
      {rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No decisions recorded for {stage}.</p> : <>
        <figure aria-labelledby="agreement-chart-caption" className="mb-4 border border-border p-3 rounded-lg">
          <figcaption id="agreement-chart-caption" className="mb-3 text-sm">{stage} decision shares by {report.bucket}. Accepted, edited and rejected values appear in the table below.</figcaption>
          <div className="space-y-2" role="img" aria-label={`${stage} agreement chart; exact counts and percentages in the agreement table`}>
            {rows.map(row => <div key={row.period} className="flex items-center gap-3 text-xs"><span className="w-20 shrink-0">{row.period}</span><div className="flex h-4 flex-1 bg-muted" aria-hidden="true"><span className="bg-emerald-600" style={{ width: `${(row.accepted_share ?? 0) * 100}%` }} /><span className="bg-amber-500" style={{ width: `${(row.edited_share ?? 0) * 100}%` }} /><span className="bg-destructive" style={{ width: `${(row.rejected_share ?? 0) * 100}%` }} /></div><span className="w-6 text-right">{row.total}</span></div>)}
          </div>
        </figure>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{stage} agreement counts and shares</caption><thead><tr className="border-b border-border">{["Period (UTC)", "Total", "Accepted", "Edited", "Rejected"].map(label => <th key={label} scope="col" className="p-2 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.period} className="border-b border-border"><th scope="row" className="p-2 font-normal">{row.period}</th><td className="p-2">{row.total}</td><td className="p-2">{row.accepted} ({percent(row.accepted_share)})</td><td className="p-2">{row.edited} ({percent(row.edited_share)})</td><td className="p-2">{row.rejected} ({percent(row.rejected_share)})</td></tr>)}</tbody></table></div>
      </>}
    </section>
    <section aria-labelledby="candidate-heading" className="border-t border-border pt-5">
      <h2 id="candidate-heading" className="text-base font-semibold">Prompt candidates</h2>
      <p className="my-2 text-sm text-muted-foreground">Create a version from validated disagreement lessons in this workspace. Decisions reserved for evaluation stay excluded. A candidate needs evaluation and approval before use.</p>
      <Button onClick={() => void propose()} disabled={busy}>{busy ? "Working…" : `Create ${stage} candidate`}</Button>
      {created && <div role="status" className="mt-3 text-sm" data-testid="learning-created"><p>Candidate created: {created.id}. The active prompt is unchanged.</p><p className="mt-2 whitespace-pre-wrap">{created.instruction_text}</p></div>}
      {report.revisions.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No prompt candidates created.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Prompt revision history</caption><thead><tr className="border-b border-border">{["Version", "Stage", "State", "Parent", "Training / held out", "Creator / time"].map(label => <th scope="col" key={label} className="p-2 font-medium">{label}</th>)}</tr></thead><tbody>{report.revisions.map(revision => <tr key={revision.id} className="border-b border-border"><th scope="row" className="p-2 font-mono text-xs font-normal">{revision.id}</th><td className="p-2">{revision.stage}</td><td className="p-2">{revision.state}</td><td className="p-2 text-xs">{revision.parent_revision}</td><td className="p-2">{revision.training_count} / {revision.heldout_count}</td><td className="p-2">{revision.creator.name}<br />{revision.created_at.slice(0, 16).replace("T", " ")} UTC</td></tr>)}</tbody></table></div>}
      <p className="mt-4 text-sm text-muted-foreground">A sweep champion is only the best score in a sweep. Only an explicitly approved active revision changes live instructions.</p>
      {report.revisions.filter(r=>r.stage===stage).map(revision=>{
        const evaluation=report.evaluations?.find(e=>e.revision_id===revision.id);
        const parent=report.revisions.find(r=>r.id===revision.parent_revision);
        return <details key={revision.id} className="mt-4 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm">{revision.id} · {revision.state} · instructions and evaluation</summary>
          <div className="mt-3 space-y-3 text-sm">
            <p>Previous additional instructions</p><pre className="whitespace-pre-wrap break-words font-sans">{parent?.instruction_text || "Baseline — no additional approved instructions."}</pre>
            <p>Candidate additional instructions</p><pre className="whitespace-pre-wrap break-words font-sans">{revision.instruction_text}</pre>
            <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={()=>void act({action:"evaluate",revision_id:revision.id})}>Evaluate {revision.id}</Button>
              {revision.state==='active' ? <Button disabled={busy} variant="outline" onClick={()=>void act({action:"rollback",stage:revision.stage,expected_active_id:revision.id})}>Roll back {revision.id}</Button> : <Button disabled={busy||!evaluation?.eligible} variant="outline" onClick={()=>void act({action:"approve",revision_id:revision.id,evaluation_id:evaluation!.id,expected_active_id:evaluation!.baseline_revision_id})}>Approve {revision.id}</Button>}
            </div>
            {evaluation && <div aria-label={`Evaluation ${revision.id}`}>
              <p>{evaluation.eligible ? "Eligible for explicit approval" : "Not eligible for approval"}. Gold cases: {evaluation.baseline.gold_count} / {evaluation.candidate.gold_count}; replay cases: {evaluation.baseline.replay_count} / {evaluation.candidate.replay_count} (baseline / candidate).</p>
              <p>Combined score: {evaluation.baseline.combined.toFixed(4)} → {evaluation.candidate.combined.toFixed(4)}. Equal weight for gold and replay composites.</p>
              <p>Model: {evaluation.route.model} · {evaluation.route.provider_id}</p>
              {evaluation.reasons.map(reason=><p key={reason}>{reason}</p>)}
              <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Individual evaluation metrics</caption><thead><tr><th className="p-2">Evidence / metric</th><th className="p-2">Baseline</th><th className="p-2">Candidate</th><th className="p-2">Scored cases</th></tr></thead><tbody>{(['gold','replay'] as const).flatMap(kind=>evaluation.baseline[kind].map(metric=>{const candidate=evaluation.candidate[kind].find(m=>m.name===metric.name);return <tr key={`${kind}-${metric.name}`} className="border-t border-border"><th className="p-2 font-normal">{kind} / {metric.name}</th><td className="p-2">{metric.value.toFixed(4)}</td><td className="p-2">{candidate?.value.toFixed(4)??'Missing'}</td><td className="p-2">{metric.denominator} / {candidate?.denominator??0}</td></tr>}))}</tbody></table></div>
              <p>Excluded cases: {Object.keys(evaluation.excluded).length}</p>{Object.entries(evaluation.excluded).map(([id,reason])=><p key={id} className="break-words">{id}: {reason}</p>)}
              {evaluation.failures.map((failure,i)=><p key={i} className="break-words">{failure}</p>)}
            </div>}
          </div>
        </details>;
      })}
    </section>
    <section aria-label="Prompt activation history" className="border-t border-border pt-5"><h2 className="text-base font-semibold">Approval and rollback history</h2>{report.history?.length ? report.history.map(item=><p key={item.id} className="mt-2 break-words text-sm">{item.stage} · {item.action} · {item.before_id??'baseline'} → {item.after_id??'baseline'} · {item.actor.name} · {item.created_at}</p>):<p className="mt-2 text-sm text-muted-foreground">No prompt activation changes.</p>}</section>
  </div>;
}
