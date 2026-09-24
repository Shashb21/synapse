"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, Loader2, Play, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS, type SourceType } from "@/lib/iegp/enums";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { useAiEnabled } from "@/components/platform/ai-status";

type StageStep = { stage: string; label: string; input?: Record<string, unknown> };

type StepState = { status: "idle" | "running" | "ok" | "error"; detail?: string };

async function runOne(step: StageStep, identity: ActionIdentity) {
  const res = await fetch("/api/modules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stage: step.stage,
      input: step.input ?? {},
      actor_name: identity.actor_name,
      actor_function: identity.actor_function,
    }),
  });
  const json = (await res.json()) as { error?: string; summary?: string; mode?: string };
  if (!res.ok) throw new Error(json.error ?? `${step.stage} failed`);
  return json;
}

/** Runs a fixed chain of stages in order and reports each one as it lands. Hidden while AI is off. */
export function ChainRunner(props: { steps: StageStep[]; label: string; identity: ActionIdentity }) {
  return useAiEnabled() ? <Chain {...props} /> : null;
}

function Chain({
  steps,
  label,
  identity,
}: {
  steps: StageStep[];
  label: string;
  identity: ActionIdentity;
}) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setState({});
    for (const step of steps) {
      setState((prev) => ({ ...prev, [step.stage]: { status: "running" } }));
      try {
        const result = await runOne(step, identity);
        setState((prev) => ({
          ...prev,
          [step.stage]: { status: "ok", detail: result.summary },
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          [step.stage]: {
            status: "error",
            detail: error instanceof Error ? error.message : "failed",
          },
        }));
        break;
      }
    }
    setRunning(false);
    router.refresh();
  }

  return (
    <div className="grid gap-2">
      <Button size="sm" disabled={running} onClick={() => void run()}>
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        {label}
      </Button>
      {steps.some((step) => state[step.stage]) ? (
        <ol className="grid gap-1">
          {steps.map((step) => {
            const status = state[step.stage]?.status ?? "idle";
            return (
              <li key={step.stage} className="flex items-start gap-2 text-[11px]">
                {status === "running" ? (
                  <Loader2 className="mt-0.5 size-3 animate-spin text-muted-foreground" aria-hidden />
                ) : status === "ok" ? (
                  <CircleCheck className="mt-0.5 size-3 text-[var(--known)]" aria-hidden />
                ) : status === "error" ? (
                  <TriangleAlert className="mt-0.5 size-3 text-destructive" aria-hidden />
                ) : (
                  <span className="mt-1 size-2 rounded-full border border-border" aria-hidden />
                )}
                <span
                  className={cn(
                    "min-w-0",
                    status === "error" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  <span className="text-foreground">{step.label}</span>
                  {state[step.stage]?.detail ? ` — ${state[step.stage]!.detail}` : ""}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

type UploadFormProps = {
  demoOptions: { id: string; title: string; filename: string }[];
  identity: ActionIdentity;
};

/**
 * S0 upload: demo pack files or a pasted note. S1 parses whatever lands.
 * With AI off there is no upload or parsing at all; the form is not rendered.
 */
export function ModularUploadForm(props: UploadFormProps) {
  return useAiEnabled() ? <UploadForm {...props} /> : null;
}

function UploadForm({ demoOptions, identity }: UploadFormProps) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("stakeholder_interview");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(parseToo: boolean) {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const files = text.trim()
        ? [
            {
              filename: `${(title || "pasted-note").replaceAll(" ", "-").toLowerCase()}.txt`,
              title: title || "Pasted note",
              source_type: sourceType,
              stakeholder_function: identity.actor_function,
              text,
              mime: "text/plain",
            },
          ]
        : [];
      if (files.length === 0 && picked.length === 0) {
        throw new Error("Pick a demo file or paste some text first.");
      }
      const upload = await runOne(
        { stage: "S0", label: "Upload", input: { files, demo_ids: picked } },
        identity,
      );
      let detail = upload.summary ?? "uploaded";
      if (parseToo) {
        const parsed = await runOne({ stage: "S1", label: "Parse", input: {} }, identity);
        detail = `${detail}; ${parsed.summary ?? "parsed"}`;
      }
      setMessage(detail);
      setPicked([]);
      setText("");
      setTitle("");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-1">
        <legend className="text-[11px] text-muted-foreground">Demo pack</legend>
        {demoOptions.map((option) => (
          <label key={option.id} className="flex items-center gap-2 text-[12px] text-foreground">
            <input
              type="checkbox"
              checked={picked.includes(option.id)}
              onChange={(event) =>
                setPicked((prev) =>
                  event.target.checked ? [...prev, option.id] : prev.filter((id) => id !== option.id),
                )
              }
            />
            <span className="min-w-0 truncate">{option.title}</span>
            <span className="text-[11px] text-muted-foreground">{option.filename}</span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-2 border-t border-border pt-3">
        <p className="text-[11px] text-muted-foreground">Or paste a source</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Title
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Advisory board notes" />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            Source type
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground"
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value as SourceType)}
            >
              {SOURCE_TYPES.map((option) => (
                <option key={option} value={option}>
                  {SOURCE_TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => void upload(true)}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Upload and parse
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void upload(false)}>
          Upload only
        </Button>
      </div>
      {message ? <p className="text-[11px] text-muted-foreground">{message}</p> : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
