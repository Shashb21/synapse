"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, type ActorFunction } from "@/lib/iegp/enums";
import type { AxesConfig, PriorityAxis } from "@/modules/stages/s8-prioritization/axes";

const FIELD_CLASS = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground";

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function emptyAxis(index: number): PriorityAxis {
  return {
    id: `axis_${index}`,
    label: `New axis ${index}`,
    description: "",
    weight: 1,
    low_label: "Low",
    high_label: "High",
    cues: [],
  };
}

/**
 * The axes config is a nested object, so it needs its own form rather than the
 * generic action dialog. It posts the whole config to the control API, which
 * validates it again server-side.
 */
export function AxesEditor({
  config,
  updatedBy,
  updatedAt,
  identity,
  mayPrioritize,
}: {
  config: AxesConfig;
  updatedBy: string;
  updatedAt: string;
  identity: ActionIdentity;
  mayPrioritize: boolean;
}) {
  const router = useRouter();
  const [axes, setAxes] = useState<PriorityAxis[]>(config.axes);
  const [xAxis, setXAxis] = useState(config.x_axis);
  const [yAxis, setYAxis] = useState(config.y_axis);
  const [high, setHigh] = useState(String(config.bands.high));
  const [medium, setMedium] = useState(String(config.bands.medium));
  const [actorName, setActorName] = useState(identity.signed_in ? identity.actor_name : "");
  const [actorFunction, setActorFunction] = useState<ActorFunction>(identity.actor_function);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function patch(index: number, change: Partial<PriorityAxis>) {
    setAxes((current) => current.map((axis, i) => (i === index ? { ...axis, ...change } : axis)));
  }

  function removeAxis(index: number) {
    setAxes((current) => current.filter((_, i) => i !== index));
  }

  function addAxis() {
    setAxes((current) => [...current, emptyAxis(current.length + 1)]);
  }

  /** Mirrors the server guard so the user sees the problem before the round trip. */
  function localProblem(next: AxesConfig): string | null {
    if (next.axes.length < 2) return "At least two axes are required.";
    if (next.axes.some((axis) => !axis.id.trim())) return "Every axis needs an id.";
    if (new Set(next.axes.map((axis) => axis.id)).size !== next.axes.length) {
      return "Axis ids must be unique.";
    }
    const ids = new Set(next.axes.map((axis) => axis.id));
    if (!ids.has(next.x_axis) || !ids.has(next.y_axis)) {
      return "The matrix axes must reference configured axes.";
    }
    if (next.x_axis === next.y_axis) return "Pick two different axes for the matrix.";
    if (!Number.isFinite(next.bands.high) || !Number.isFinite(next.bands.medium)) {
      return "Both thresholds must be numbers.";
    }
    if (next.bands.high <= next.bands.medium) {
      return "The High threshold must sit above the Medium threshold.";
    }
    if (next.axes.some((axis) => !Number.isFinite(axis.weight) || axis.weight < 0)) {
      return "Weights must be zero or greater.";
    }
    return null;
  }

  async function save() {
    setError(null);
    setSaved(null);
    const next: AxesConfig = {
      axes: axes.map((axis) => ({ ...axis, id: axis.id.trim(), weight: Number(axis.weight) })),
      x_axis: xAxis,
      y_axis: yAxis,
      bands: { high: Number(high), medium: Number(medium) },
    };
    const problem = localProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    if (!identity.signed_in && !actorName.trim()) {
      setError("Type your name so the config change has an actor.");
      return;
    }
    setPending(true);
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save_axes",
        config: next,
        actor_name: actorName.trim() || identity.actor_name,
        actor_function: actorFunction,
      }),
    });
    const json = (await res.json()) as { error?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Saving the axes failed.");
      return;
    }
    setSaved("Axes saved. Re-run S8 to rescore the open gaps on the new axes.");
    router.refresh();
  }

  return (
    <section className="rounded-md border border-border bg-card/40">
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-3">
          <span className="text-[13px] text-foreground">Axes configuration</span>
          <span className="text-[11px] text-muted-foreground">
            {axes.length} axes · High {config.bands.high} / Medium {config.bands.medium} · last updated by{" "}
            {updatedBy}
            {updatedAt && updatedAt !== "—" ? ` · ${updatedAt.slice(0, 10)}` : ""}
          </span>
        </summary>
        <div className="grid gap-3 border-t border-border p-3">
          {!mayPrioritize ? (
            <p className="text-[12px] text-muted-foreground">
              Your role may read the axes but not change them.
            </p>
          ) : null}
          <div className="grid gap-3">
            {axes.map((axis, index) => (
              <article key={`${axis.id}-${index}`} className="grid gap-2 rounded-md border border-border bg-background p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="grid flex-1 gap-1 text-[11px] text-muted-foreground">
                    Label
                    <Input
                      value={axis.label}
                      disabled={!mayPrioritize}
                      onChange={(event) =>
                        patch(index, {
                          label: event.target.value,
                          id:
                            axis.id === slugify(axis.label, axis.id)
                              ? slugify(event.target.value, axis.id)
                              : axis.id,
                        })
                      }
                    />
                  </label>
                  <label className="grid w-40 gap-1 text-[11px] text-muted-foreground">
                    Id (keys the scores)
                    <Input
                      value={axis.id}
                      disabled={!mayPrioritize}
                      onChange={(event) => patch(index, { id: event.target.value })}
                    />
                  </label>
                  <label className="grid w-20 gap-1 text-[11px] text-muted-foreground">
                    Weight
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      value={axis.weight}
                      disabled={!mayPrioritize}
                      onChange={(event) => patch(index, { weight: Number(event.target.value) })}
                    />
                  </label>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${axis.label}`}
                    disabled={!mayPrioritize}
                    onClick={() => removeAxis(index)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <label className="grid gap-1 text-[11px] text-muted-foreground">
                  Description
                  <Textarea
                    rows={2}
                    value={axis.description}
                    disabled={!mayPrioritize}
                    onChange={(event) => patch(index, { description: event.target.value })}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <label className="grid flex-1 gap-1 text-[11px] text-muted-foreground">
                    Low end label
                    <Input
                      value={axis.low_label}
                      disabled={!mayPrioritize}
                      onChange={(event) => patch(index, { low_label: event.target.value })}
                    />
                  </label>
                  <label className="grid flex-1 gap-1 text-[11px] text-muted-foreground">
                    High end label
                    <Input
                      value={axis.high_label}
                      disabled={!mayPrioritize}
                      onChange={(event) => patch(index, { high_label: event.target.value })}
                    />
                  </label>
                </div>
                <label className="grid gap-1 text-[11px] text-muted-foreground">
                  Cues that raise this axis (comma separated)
                  <Textarea
                    rows={2}
                    value={axis.cues.join(", ")}
                    disabled={!mayPrioritize}
                    onChange={(event) =>
                      patch(index, {
                        cues: event.target.value
                          .split(",")
                          .map((cue) => cue.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </article>
            ))}
          </div>
          <div>
            <Button size="sm" variant="outline" disabled={!mayPrioritize} onClick={addAxis}>
              <Plus className="size-3.5" /> Add axis
            </Button>
          </div>
          <div className="flex flex-wrap gap-3 border-t border-border pt-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Matrix x axis
              <select
                className={FIELD_CLASS}
                value={xAxis}
                disabled={!mayPrioritize}
                onChange={(event) => setXAxis(event.target.value)}
              >
                {axes.map((axis) => (
                  <option key={axis.id} value={axis.id}>
                    {axis.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Matrix y axis
              <select
                className={FIELD_CLASS}
                value={yAxis}
                disabled={!mayPrioritize}
                onChange={(event) => setYAxis(event.target.value)}
              >
                {axes.map((axis) => (
                  <option key={axis.id} value={axis.id}>
                    {axis.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid w-28 gap-1 text-[11px] text-muted-foreground">
              High at or above
              <Input
                type="number"
                value={high}
                disabled={!mayPrioritize}
                onChange={(event) => setHigh(event.target.value)}
              />
            </label>
            <label className="grid w-28 gap-1 text-[11px] text-muted-foreground">
              Medium at or above
              <Input
                type="number"
                value={medium}
                disabled={!mayPrioritize}
                onChange={(event) => setMedium(event.target.value)}
              />
            </label>
          </div>
          {!identity.signed_in ? (
            <div className="flex flex-wrap gap-3 border-t border-border pt-3">
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                Name
                <Input
                  value={actorName}
                  placeholder="Your name"
                  disabled={!mayPrioritize}
                  onChange={(event) => setActorName(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                Function
                <select
                  className={FIELD_CLASS}
                  value={actorFunction}
                  disabled={!mayPrioritize}
                  onChange={(event) => setActorFunction(event.target.value as ActorFunction)}
                >
                  {ACTOR_FUNCTIONS.map((fn) => (
                    <option key={fn} value={fn}>
                      {FUNCTION_LABELS[fn]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          {saved ? <p className="text-[12px] text-muted-foreground">{saved}</p> : null}
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={pending || !mayPrioritize} onClick={() => void save()}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {pending ? "Saving…" : "Save axes"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Saved axes do not rescore gaps on their own — re-run S8 afterwards.
            </span>
          </div>
        </div>
      </details>
    </section>
  );
}
