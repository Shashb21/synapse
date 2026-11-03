/** Shared requested-provider controls for isolated generation and evaluation. */
"use client";

import { Input } from "@/components/ui/input";
import type { ExecutionRoute } from "@/modules/development/execution-schema";
import type { ProviderKeyView } from "@/modules/llm/api-keys";

export const routeSelectClass = "w-full min-w-0 rounded-lg border border-input bg-background px-2 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const selectClass = routeSelectClass;

/** Edit one complete requested route using the owner-readable provider catalog. */
export function RouteFields({ value, onChange, providers }: { value: ExecutionRoute; onChange: (route: ExecutionRoute) => void; providers: ProviderKeyView[] }) {
  const provider = providers.find((item) => item.provider_id === value.provider_id);
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className="block space-y-1">Provider<select className={selectClass} value={value.provider_id} onChange={(event) => { const next = providers.find((item) => item.provider_id === event.target.value); if (next) onChange({ ...value, provider_id: next.provider_id, model: next.default_model, fallbacks: value.fallbacks.filter((id) => id !== next.provider_id) }); }}>{providers.map((item) => <option key={item.provider_id} value={item.provider_id}>{item.label} ({item.status === "configured" ? "key present" : "no key"})</option>)}</select></label>
    <label className="block space-y-1">Model<select className={selectClass} value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value })}>{provider?.models.map((model) => <option key={model}>{model}</option>)}</select></label>
    <label className="block space-y-1">Temperature<Input type="number" min="0" max="2" step="0.1" value={Number.isNaN(value.temperature) ? "" : value.temperature} onChange={(event) => onChange({ ...value, temperature: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></label>
    <label className="block space-y-1">Maximum output tokens<Input type="number" min="256" max="64000" step="1" value={Number.isNaN(value.max_tokens) ? "" : value.max_tokens} onChange={(event) => onChange({ ...value, max_tokens: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></label>
    <fieldset className="sm:col-span-2"><legend>Allowed fallbacks (in listed order)</legend><div className="flex flex-wrap gap-3 mt-1">{providers.filter((item) => item.provider_id !== value.provider_id).map((item) => <label key={item.provider_id} className="flex gap-1 items-center"><input type="checkbox" checked={value.fallbacks.includes(item.provider_id)} onChange={(event) => onChange({ ...value, fallbacks: event.target.checked ? [...value.fallbacks, item.provider_id] : value.fallbacks.filter((id) => id !== item.provider_id) })} />{item.label}</label>)}</div><p className="text-muted-foreground">Order: {value.fallbacks.join(", ") || "none"}</p></fieldset>
  </div>;
}

