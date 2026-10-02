"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { FileText, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RerunMappingButton } from "@/components/platform/rerun-mapping-button";
import {
  ACTOR_FUNCTIONS,
  FUNCTION_LABELS,
  SOURCE_TYPE_LABELS,
  SOURCE_TYPES,
} from "@/lib/iegp/enums";

const FIELD = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

/**
 * Add a source (owner feedback, KAN-52): the whole form is on the page, no dialog. Choose a
 * text file or paste the text, name it, say what kind of source it is, and Synapse reads it.
 */
export function AddSourceForm({ demoFiles = false }: { demoFiles?: boolean }) {
  const router = useRouter();
  const fileId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The mapping step (S4) failed after the source was read: offer to run it again (KAN-68).
  const [mappingFailed, setMappingFailed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!/\.(txt|md|markdown)$/i.test(file.name) && !file.type.startsWith("text/")) {
      setError("Choose a .txt or .md file, or paste the text below.");
      return;
    }
    setFileName(file.name);
    setText(await file.text());
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, "").replaceAll(/[_-]+/g, " "));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    setMappingFailed(false);
    setDone(null);
    if (!title.trim()) {
      setError("Give the source a title.");
      return;
    }
    if (!text.trim()) {
      setError("Choose a file or paste the source text.");
      return;
    }
    setPending(true);
    const res = await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "ingest",
        note: "",
        title: title.trim(),
        ...(fileName ? { filename: fileName } : {}),
        text,
        source_type: String(data.get("source_type") ?? ""),
        stakeholder_function: String(data.get("stakeholder_function") ?? ""),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; stage?: string };
    setPending(false);
    if (!res.ok) {
      setError(json.error ?? "Could not read the source. Try again.");
      setMappingFailed(json.stage === "S4");
      return;
    }
    setDone(`Read “${title.trim()}”. Its gaps and tactics are on Evidence Inventory.`);
    setTitle("");
    setText("");
    setFileName(null);
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  return (
    <section aria-labelledby="add-source" className="rounded-lg border border-border bg-card p-4">
      <h2 id="add-source" className="text-[13px] font-semibold text-foreground">
        Add a source
      </h2>
      <p className="mt-1 max-w-3xl text-[12px] leading-5 text-muted-foreground">
        Upload a text file or paste text: interview notes, a literature review, a plan excerpt. Synapse reads it and
        pulls out the evidence gaps and existing tactics it mentions; you review every one on Evidence Inventory.
        {demoFiles ? " The demo files above can be downloaded and added here too." : ""}
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3" noValidate aria-label="Add a source">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            id={fileId}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="sr-only"
            onChange={(event) => void pickFile(event.currentTarget.files?.[0])}
          />
          <label
            htmlFor={fileId}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-foreground hover:bg-muted focus-within:ring-2 focus-within:ring-ring"
          >
            <Upload className="size-3.5" aria-hidden />
            Choose file
          </label>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="chosen-file">
            {fileName ? (
              <>
                <FileText className="size-3.5" aria-hidden /> {fileName}
              </>
            ) : (
              ".txt or .md — or paste the text below"
            )}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={LABEL}>
            Title
            <input
              name="title"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. HEOR stakeholder interviews"
              className={FIELD}
            />
          </label>
          <label className={LABEL}>
            Source type
            <select name="source_type" className={FIELD} defaultValue={SOURCE_TYPES[0]}>
              {SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SOURCE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Whose view it is
            <select name="stakeholder_function" className={FIELD} defaultValue={ACTOR_FUNCTIONS[0]}>
              {ACTOR_FUNCTIONS.map((fn) => (
                <option key={fn} value={fn}>
                  {FUNCTION_LABELS[fn]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={LABEL}>
          Source text
          <textarea
            name="text"
            required
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste the notes or document text here, or choose a file above."
            className="w-full rounded-lg border border-input bg-card px-2.5 py-2 text-[12px] font-normal normal-case tracking-normal text-foreground"
          />
        </label>
        {error ? (
          <div className="grid gap-2">
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
            {mappingFailed ? (
              <RerunMappingButton
                onDone={(ok) => {
                  if (!ok) return;
                  setError(null);
                  setMappingFailed(false);
                  setDone("Mapping finished. The mapping table shows the new proposal.");
                }}
              />
            ) : null}
          </div>
        ) : null}
        {done ? (
          <p role="status" className="text-[12px] text-[var(--known-foreground)]">
            {done}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Reading…" : "Add and read source"}
          </Button>
        </div>
      </form>
    </section>
  );
}
