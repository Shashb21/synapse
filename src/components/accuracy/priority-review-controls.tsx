"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAiEnabled } from "@/components/platform/ai-status";
import type { AccuracyPlacement, AccuracyPriorityConfig } from "@/accuracy/store/priority-store";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axes";
import type { ProvenanceSpan } from "@/accuracy/store/quote-validator";
import { ClaimEvidence } from "./claim-evidence";
import { sendJson } from "./claim-api";

type PriorityRead = {
  config: AccuracyPriorityConfig; placements: AccuracyPlacement[]; eligible: boolean; skipped_reason: string | null;
  expected_input_revision: string; expected_config_revision: string; axes: PriorityAxis[]; x_axis: string; y_axis: string; pair_chosen: boolean;
  context: Record<string, unknown>; considerations: Record<string, { state: string; text: string; references: ProvenanceSpan[] }>;
  references: ProvenanceSpan[]; limitations: string[];
};
type FreshSuggestion = { gap_id: string; suggested_band: string; rationale: string };
const buttonClass = "border border-border px-2 py-1 text-[11px] disabled:opacity-40 hover:bg-muted/40";
const inputClass = "border border-border bg-background px-2 py-1 text-[12px]";

export function PriorityReviewControls({ workspaceId, gapId }: { workspaceId: string; gapId: string }) {
  const router = useRouter(), aiOn = useAiEnabled();
  const [open, setOpen] = useState(false), [input, setInput] = useState<PriorityRead | null>(null), [catalog, setCatalog] = useState<PriorityAxis[]>([]);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [setting, setSetting] = useState("all"), [xAxis, setX] = useState(""), [yAxis, setY] = useState("");
  const [useSavedPair, setUseSavedPair] = useState(false);
  const [band, setBand] = useState("medium"), [rationale, setRationale] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<FreshSuggestion[]>([]), [skipped, setSkipped] = useState<{ gap_id: string; reason: string }[]>([]);
  const [configRationale, setConfigRationale] = useState("");
  const [decision, setDecision] = useState(""), [decisionDate, setDecisionDate] = useState("");

  async function load(preserveNewSuggestion = false) {
    setOpen(true); setPending(true); setError(null); setInput(null);
    if (!preserveNewSuggestion) { setSuggestions([]); setSkipped([]); }
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId, gap_id: gapId, setting });
      let selectedX = xAxis, selectedY = yAxis;
      if (useSavedPair) {
        // Read the canonical configuration without a gap so a stored placement
        // cannot override the new setting's pair when axes are omitted.
        const configQuery = new URLSearchParams({ workspace_id: workspaceId, setting });
        const configResponse = await fetch(`/api/accuracy/claims/priority?${configQuery}`);
        const configJson = await configResponse.json();
        if (!configResponse.ok) { setSuggestions([]); setSkipped([]); setError(configJson.error ?? "Could not read saved priority configuration."); return; }
        const config = configJson.config as AccuracyPriorityConfig;
        const saved = config.scopes[setting.trim().toLowerCase() || "all"];
        selectedX = saved?.x_axis ?? config.catalog.x_axis;
        selectedY = saved?.y_axis ?? config.catalog.y_axis;
      }
      if (selectedX && selectedY) { query.set("x_axis", selectedX); query.set("y_axis", selectedY); }
      const response = await fetch(`/api/accuracy/claims/priority?${query}`);
      const json = await response.json();
      if (!response.ok) { setSuggestions([]); setSkipped([]); setError(json.error ?? "Could not read priority inputs."); return; }
      const read = json as PriorityRead;
      if (input && (read.expected_input_revision !== input.expected_input_revision || read.expected_config_revision !== input.expected_config_revision)) {
        setSuggestions([]); setSkipped([]);
      }
      setInput(read); setCatalog(read.config.catalog?.axes ?? read.axes); setX(read.x_axis); setY(read.y_axis);
      const placement = read.placements.find(row => row.gap_id === gapId);
      setBand(placement?.band ?? placement?.suggested_band ?? "medium");
      setScores(Object.fromEntries(Object.entries(placement?.axis_scores ?? {}).map(([id, value]) => [id, String(value)])));
      setDecision(String(read.context.key_decision ?? "")); setDecisionDate(String(read.context.decision_date ?? ""));
    } catch { setSuggestions([]); setSkipped([]); setError("Could not read current priority inputs. Retry; manual work remains available."); }
    finally { setPending(false); }
  }
  async function save(validate: boolean) {
    if (!input || !input.eligible) return;
    setPending(true); setError(null); setMessage(null);
    const axis_scores = Object.fromEntries(input.axes.filter(axis => scores[axis.id]?.trim()).map(axis => [axis.id, Number(scores[axis.id])]));
    const result = await sendJson("/api/accuracy/claims/priority", "POST", { action: validate ? "validate" : "set", workspace_id: workspaceId, gap_id: gapId,
      setting, x_axis: input.x_axis, y_axis: input.y_axis, band, rationale,
      expected_input_revision: input.expected_input_revision, expected_config_revision: input.expected_config_revision,
      ...(Object.keys(axis_scores).length ? { axis_scores } : {}) });
    setPending(false);
    if (!result.ok) { setError(`${result.error} Reload current priority inputs before trying again.`); return; }
    setMessage(validate ? "Human working priority validated." : "Human working priority saved; not validated.");
    await load(); router.refresh();
  }
  async function suggest() {
    if (!input) return;
    setPending(true); setError(null); setMessage(null);
    const result = await sendJson("/api/accuracy/claims/priority", "POST", { action: "suggest", workspace_id: workspaceId, gap_ids: [gapId], setting, x_axis: input.x_axis, y_axis: input.y_axis });
    setPending(false);
    if (!result.ok) { setError(`${result.error} Enter a working band and rationale manually, or retry the suggestion.`); return; }
    setSuggestions((result.json.suggestions ?? []) as FreshSuggestion[]); setSkipped((result.json.skipped ?? []) as { gap_id: string; reason: string }[]);
    setMessage(`Priority suggestion (${result.json.mode ?? "unknown"}); review before human validation.`);
    await load(true); router.refresh();
  }
  async function configure() {
    if (!input) return;
    setPending(true); setError(null);
    const result = await sendJson("/api/accuracy/claims/priority", "POST", { action: "configure", workspace_id: workspaceId,
      expected_config_revision: input.config.revision, scope: setting, x_axis: xAxis, y_axis: yAxis,
      context: { key_decision: decision, decision_date: decisionDate }, rationale: configRationale });
    setPending(false);
    if (!result.ok) { setError(`${result.error} Reload the configuration before saving.`); return; }
    setMessage("Accuracy configuration saved. Recheck any stale human priority decisions."); await load(); router.refresh();
  }
  const placement = input?.placements.find(row => row.gap_id === gapId);
  const savedPair = input?.config.scopes?.[setting.trim().toLowerCase() || "all"];
  const matchesSavedPair = savedPair?.x_axis === input?.x_axis && savedPair?.y_axis === input?.y_axis;
  return <div className="mt-3 grid gap-2">
    <button className={buttonClass} type="button" disabled={pending} onClick={() => open ? setOpen(false) : void load()}>{open ? "Close S8 priority" : "Review S8 priority"}</button>
    {open ? <section className="grid gap-2 border-t border-border pt-2" aria-label="S8 priority review">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="grid gap-1 text-[12px]">Setting<input className={inputClass} disabled={pending} value={setting} onChange={e => { setSetting(e.target.value); setUseSavedPair(true); setX(""); setY(""); setInput(null); setSuggestions([]); setSkipped([]); }} /></label>
        {(["x", "y"] as const).map(axis => <label key={axis} className="grid gap-1 text-[12px]">{axis === "x" ? "Horizontal" : "Vertical"} axis<select className={inputClass} disabled={pending || (useSavedPair && !input)} value={axis === "x" ? xAxis : yAxis} onChange={e => { (axis === "x" ? setX : setY)(e.target.value); setUseSavedPair(false); setInput(null); setSuggestions([]); setSkipped([]); }}>
          <option value="">Saved axis</option>
          {catalog.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select></label>)}
      </div>
      <button className={buttonClass} type="button" disabled={pending} onClick={() => void load()}>Reload current priority inputs</button>
      {input ? <>
        <p className="text-[12px]">{input.eligible ? "Eligible Open gap" : `Priority unavailable: ${input.skipped_reason}`} · {matchesSavedPair ? "Saved axis pair" : "Custom axis pair — not saved for this setting"}</p>
        <p className="text-[12px]">Suggestion: {placement?.suggested_band ?? "None"} · {placement?.suggested_rationale ?? "No model suggestion"}</p>
        <p className="text-[12px]">Human working decision: {placement?.human_revision ? placement.band : "None"} · Validation: {placement?.validation?.freshness ?? "unvalidated"}{placement?.actor_name ? ` · ${placement.actor_name} · ${placement.rationale}` : ""}</p>
        {placement?.validation ? <p className="text-[11px]">Validated by {placement.validation.by} · {placement.validation.at} · {placement.validation.rationale}</p> : null}
        <ClaimEvidence workspaceId={workspaceId} spans={input.references} />
        {input.limitations.length ? <ul className="text-[12px] text-muted-foreground">{input.limitations.map(text => <li key={text}>{text}</li>)}</ul> : null}
        <details><summary className="text-[12px]">Planning context and considerations</summary>
          <p className="text-[12px]">{Object.entries(input.context).map(([key, value]) => `${key.replaceAll("_", " ")}: ${value}`).join(" · ") || "No planning context supplied."}</p>
          {Object.entries(input.considerations).map(([key, row]) => <div key={key} className="text-[12px]">{key.replaceAll("_", " ")}: {row.state} · {row.text}<ClaimEvidence workspaceId={workspaceId} spans={row.references} /></div>)}
        </details>
        <label className="grid gap-1 text-[12px]">Working priority<select className={inputClass} value={band} onChange={e => setBand(e.target.value)}>{["high", "medium", "low", "defer"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="grid gap-2 sm:grid-cols-2">{input.axes.map(axis => <label key={axis.id} className="grid gap-1 text-[12px]">{axis.label} ({axis.higher_is_priority === false ? "lower" : "higher"} is higher priority)<input className={inputClass} type="number" min={0} max={100} step={1} value={scores[axis.id] ?? ""} onChange={e => setScores({ ...scores, [axis.id]: e.target.value })} /></label>)}</div>
        <label className="grid gap-1 text-[12px]">S8 rationale (required)<textarea className={inputClass} aria-label="S8 rationale" value={rationale} onChange={e => setRationale(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} type="button" disabled={pending || !input.eligible || rationale.trim().length < 3} onClick={() => void save(false)}>Save working priority</button>
          <button className={buttonClass} type="button" disabled={pending || !input.eligible || rationale.trim().length < 3} onClick={() => void save(true)}>Validate working priority</button>
          {aiOn ? <button className={buttonClass} type="button" disabled={pending || !input.eligible} onClick={() => void suggest()}>Suggest S8 priority</button> : null}
        </div>
        <details><summary className="text-[12px]">Save Accuracy axis pair and planning context</summary>
          <div className="grid gap-2">
            <label className="grid gap-1 text-[12px]">Key decision<input className={inputClass} value={decision} onChange={e => setDecision(e.target.value)} /></label>
            <label className="grid gap-1 text-[12px]">Decision date<input className={inputClass} type="date" value={decisionDate} onChange={e => setDecisionDate(e.target.value)} /></label>
            <label className="grid gap-1 text-[12px]">Configuration rationale<textarea className={inputClass} value={configRationale} onChange={e => setConfigRationale(e.target.value)} /></label>
            <button className={buttonClass} type="button" disabled={pending || xAxis === yAxis || configRationale.trim().length < 3} onClick={() => void configure()}>Save Accuracy configuration</button>
          </div>
        </details>
        {placement?.history.length ? <details><summary className="text-[12px]">Priority decision history ({placement.history.length})</summary><ul className="text-[11px]">{placement.history.map((row, index) => <li key={index}>{String(row.action ?? "decision")} · {String(row.at ?? "")} · {String(row.rationale ?? "")}</li>)}</ul></details> : null}
      </> : null}
      {suggestions.map((row, index) => <p key={index} className="text-[12px]">Fresh suggestion: {row.suggested_band} · {row.rationale}</p>)}
      {skipped.map(row => <p key={row.gap_id} className="text-[12px]">Skipped {row.gap_id}: {row.reason}</p>)}
      {message ? <p role="status" className="text-[12px]">{message}</p> : null}
      {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    </section> : null}
  </div>;
}
