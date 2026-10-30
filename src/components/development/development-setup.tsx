/** Interactive setup; all persistence and parsing stays behind the owner API. */
"use client";

import { useEffect, useRef, useState } from "react";
import { DevelopmentExecution } from "@/components/development/development-execution";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from "@/lib/ingest/upload-formats";
import type {
  DevelopmentSection,
  Experiment,
} from "@/modules/development/schema";

type Workspace = { id: string; name: string };
type Source = { id: string; filename: string; status: string };
const root = "/api/admin/development";
const sections: Record<DevelopmentSection, string> = {
  gap_extraction: "Gap extraction",
  tactic_extraction: "Tactic extraction",
  matching_coverage: "Matching and coverage",
  partial_splitting: "Partial splitting",
};
const selectClass =
  "w-full rounded-lg border border-input bg-background px-2 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** Convert a bounded file to the API's base64 representation. */
async function fileContent(file: File): Promise<string> {
  if (!file.size) throw new Error("Choose a nonempty file.");
  if (file.size > MAX_UPLOAD_BYTES)
    throw new Error("Choose a file of 3 MiB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Prepare, persist and reopen private source/reference snapshots. */
export function DevelopmentSetup() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [draft, setDraft] = useState<Experiment | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [section, setSection] = useState<DevelopmentSection>("gap_extraction");
  const [associations, setAssociations] = useState<string[]>([]);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [structured, setStructured] = useState<File | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("Loading experiments…");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [sourceReadFailed, setSourceReadFailed] = useState(false);
  const lock = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const dirty = !!draft && name !== draft.name;

  /** Serialize requests and abort all state updates when the page unmounts. */
  async function perform(
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
  ) {
    if (lock.current) return;
    lock.current = true;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError("");
    setMessage(label);
    try {
      await action(active.signal);
    } catch (failure) {
      if (!active.signal.aborted) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Request failed. Try again.",
        );
        setMessage("");
      }
    } finally {
      if (!active.signal.aborted) {
        setBusy(false);
        lock.current = false;
      }
    }
  }

  /** Display only the API's safe message; never response bodies or raw exceptions. */
  async function api<T>(
    path: string,
    signal: AbortSignal,
    method = "GET",
    data?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        signal,
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    } catch {
      throw new Error("Unable to connect. Check your connection and retry.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (body?.code === "stale_revision") {
        setStale(true);
        throw new Error(
          "This draft changed elsewhere. Reload saved draft before saving again; your edited name will be kept.",
        );
      }
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : "Unable to complete the request. Please retry.",
      );
    }
    const body: T = await response.json().catch(() => {
      throw new Error(
        "The server returned an unreadable response. Reload the draft before retrying.",
      );
    });
    if (signal.aborted) throw new Error("Request cancelled.");
    return body;
  }

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    lock.current = true;
    async function load() {
      try {
        const list = await api<{ experiments: Experiment[] }>(
          root,
          active.signal,
        );
        const spaces = await api<{ workspaces: Workspace[] }>(
          `${root}/workspaces`,
          active.signal,
        );
        if (active.signal.aborted) return;
        setExperiments(list.experiments);
        setWorkspaces(spaces.workspaces);
        setMessage("");
      } catch {
        if (!active.signal.aborted) {
          setError("Unable to load experiments. Retry loading the page.");
          setMessage("");
        }
      } finally {
        if (!active.signal.aborted) {
          setBusy(false);
          lock.current = false;
        }
      }
    }
    void load();
    return () => {
      controller.current?.abort();
      lock.current = false;
    };
  }, []);

  function accept(experiment: Experiment) {
    setDraft(experiment);
    setExperiments((current) => [
      experiment,
      ...current.filter((item) => item.id !== experiment.id),
    ]);
  }

  /** Clear selections owned by the previous draft, including native-file backing state. */
  function resetDraftSelections() {
    setSources([]);
    setAssociations([]);
    setSourceId("");
    setSection("gap_extraction");
    setStale(false);
    setSourceReadFailed(false);
    setSourceFile(null);
    setPdf(null);
    setStructured(null);
  }

  /** Retry source choices independently of the already persisted draft. */
  async function loadSources(experimentId: string, signal: AbortSignal) {
    try {
      const available = await api<{ sources: Source[] }>(
        `${root}/${experimentId}/sources`,
        signal,
      );
      setSources(available.sources);
      setSourceReadFailed(false);
    } catch (failure) {
      if (!signal.aborted) setSourceReadFailed(true);
      throw failure;
    }
  }

  async function open(experiment: Experiment) {
    await perform("Loading draft…", async (signal) => {
      const result = await api<{ experiment: Experiment }>(
        `${root}/${experiment.id}`,
        signal,
      );
      accept(result.experiment);
      setName(result.experiment.name);
      resetDraftSelections();
      await loadSources(result.experiment.id, signal);
      setMessage("Draft opened.");
    });
  }

  async function upload(file: File | null, format?: "pdf" | "structured") {
    if (!draft || !file) return;
    await perform("Uploading and parsing…", async (signal) => {
      const content_base64 = await fileContent(file);
      const result = await api<{ experiment: Experiment }>(
        `${root}/${draft.id}/${format ? "reference-upload" : "source-upload"}`,
        signal,
        "POST",
        {
          revision: draft.revision,
          filename: file.name,
          content_base64,
          ...(format
            ? { format, section, source_document_ids: associations }
            : {}),
        },
      );
      accept(result.experiment);
      setMessage("Document saved. Any edited name still needs Save name.");
    });
  }

  return (
    <div className="space-y-6 text-sm">
      <form
        className="grid items-end gap-3 border-b border-border pb-6 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void perform("Creating experiment…", async (signal) => {
            const result = await api<{ experiment: Experiment }>(
              root,
              signal,
              "POST",
              { name: newName, source_workspace_id: workspace || null },
            );
            accept(result.experiment);
            setName(result.experiment.name);
            setNewName("");
            resetDraftSelections();
            await loadSources(result.experiment.id, signal);
            setMessage("Draft created.");
          });
        }}
      >
        <label className="space-y-2">
          New experiment name
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            required
            maxLength={120}
            disabled={busy || dirty}
          />
        </label>
        <label className="space-y-2">
          Source workspace
          <select
            className={selectClass}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            disabled={busy || dirty}
          >
            <option value="">Private uploads only</option>
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={busy || dirty || !newName.trim()}>
          Create experiment
        </Button>
      </form>
      <p
        role="status"
        aria-live="polite"
        className="min-h-5 text-muted-foreground"
      >
        {message ||
          (dirty
            ? "Unsaved name. Save it before opening another experiment."
            : "Choose or create an experiment.")}
      </p>
      {error && (
        <div
          role="alert"
          className="border border-destructive p-3 text-destructive rounded-lg"
        >
          {error}{" "}
          {draft && sourceReadFailed && (
            <>
              <span>
                Your draft is saved. Source choices could not be loaded.{" "}
              </span>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform("Loading sources…", async (signal) => {
                    await loadSources(draft.id, signal);
                    setMessage("Source choices loaded.");
                  })
                }
              >
                Retry loading sources
              </Button>
            </>
          )}
          {!draft && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => window.location.reload()}
            >
              Retry page load
            </Button>
          )}
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <section aria-label="Experiments">
          <h2 className="mb-3 font-semibold">Experiments</h2>
          {!experiments.length && (
            <p className="text-muted-foreground">No drafts yet.</p>
          )}
          <ul className="max-h-64 space-y-2 overflow-y-auto pr-1 md:max-h-[60vh]">
            {experiments.map((item) => (
              <li key={item.id}>
                <button
                  className="w-full break-words rounded-lg border border-border px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  aria-label={`Open ${item.name}`}
                  aria-current={draft?.id === item.id ? "true" : undefined}
                  disabled={busy || dirty}
                  onClick={() => void open(item)}
                >
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
        {draft && (
          <div className="min-w-0 space-y-6" key={draft.id}>
            <section className="space-y-3" aria-label="Draft details">
              <h2 className="font-semibold">Draft details</h2>
              <label className="block space-y-2">
                Experiment name
                <Input
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={busy || stale || !name.trim() || !dirty}
                  onClick={() =>
                    void perform("Saving…", async (signal) => {
                      const result = await api<{ experiment: Experiment }>(
                        `${root}/${draft.id}`,
                        signal,
                        "PATCH",
                        { name, revision: draft.revision },
                      );
                      accept(result.experiment);
                      setName(result.experiment.name);
                      setMessage("Saved.");
                    })
                  }
                >
                  Save name
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void perform("Reloading…", async (signal) => {
                      const result = await api<{ experiment: Experiment }>(
                        `${root}/${draft.id}`,
                        signal,
                      );
                      accept(result.experiment);
                      if (!dirty) setName(result.experiment.name);
                      setStale(false);
                      setMessage(
                        "Reloaded saved draft. Any edited name has been kept.",
                      );
                    })
                  }
                >
                  Reload saved draft
                </Button>
                <span className="text-muted-foreground">
                  Revision {draft.revision} · Draft
                </span>
              </div>
              <p className="text-muted-foreground">
                Workspace:{" "}
                {workspaces.find(
                  (item) => item.id === draft.source_workspace_id,
                )?.name ?? "Private uploads only"}
                . Fixed for this experiment.
              </p>
            </section>
            <fieldset
              disabled={busy || stale}
              className="space-y-3 border-t border-border pt-5"
            >
              <legend className="font-semibold">Source snapshots</legend>
              <p className="text-muted-foreground">
                Private snapshots for this experiment. Customer documents remain
                unchanged.
              </p>
              {draft.source_workspace_id && (
                <div className="space-y-2">
                  <label className="block space-y-2">
                    Workspace source
                    <select
                      className={selectClass}
                      value={sourceId}
                      onChange={(event) => setSourceId(event.target.value)}
                    >
                      <option value="">Choose an authorized source</option>
                      {sources.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.filename} · {item.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="outline"
                    disabled={!sourceId || busy || stale}
                    onClick={() =>
                      void perform("Copying source…", async (signal) => {
                        const result = await api<{ experiment: Experiment }>(
                          `${root}/${draft.id}/sources`,
                          signal,
                          "POST",
                          {
                            revision: draft.revision,
                            source_file_id: sourceId,
                          },
                        );
                        accept(result.experiment);
                        setMessage("Source snapshot saved.");
                      })
                    }
                  >
                    Copy source snapshot
                  </Button>
                </div>
              )}
              <label className="block space-y-2">
                Private source file
                <input
                  className="block w-full text-sm"
                  type="file"
                  accept={UPLOAD_ACCEPT}
                  onChange={(event) =>
                    setSourceFile(event.target.files?.[0] ?? null)
                  }
                />
              </label>
              <p className="text-muted-foreground">
                PDF, DOCX, PPTX, XLSX, TXT or Markdown; maximum 3 MiB. Uploads
                are parsed before saving.
              </p>
              <Button
                variant="outline"
                disabled={!sourceFile || busy || stale}
                onClick={() => void upload(sourceFile)}
              >
                Upload source
              </Button>
            </fieldset>
            <fieldset
              disabled={busy || stale}
              className="space-y-3 border-t border-border pt-5"
            >
              <legend className="font-semibold">
                Optional evaluation references
              </legend>
              <p className="text-muted-foreground">
                Evaluator-only: never used as generation sources. AI-parsed PDFs
                are provisional, not human approval. Missing references do not
                block future source generation.
              </p>
              <label className="block space-y-2">
                Reference section
                <select
                  className={selectClass}
                  value={section}
                  onChange={(event) =>
                    setSection(event.target.value as DevelopmentSection)
                  }
                >
                  {Object.entries(sections).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="space-y-2">
                <legend className="mb-2">Associate source snapshots</legend>
                {!draft.documents.some((item) => item.role === "source") && (
                  <p className="text-muted-foreground">
                    Add a source snapshot before uploading references.
                  </p>
                )}
                {draft.documents
                  .filter((item) => item.role === "source")
                  .map((item) => (
                    <label
                      key={item.id}
                      className="flex items-start gap-2 break-all"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Associate ${item.filename}`}
                        checked={associations.includes(item.id)}
                        onChange={(event) =>
                          setAssociations((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span>
                        {item.filename}
                        <span className="block text-xs text-muted-foreground">
                          Snapshot ID: {item.id}
                        </span>
                      </span>
                    </label>
                  ))}
              </fieldset>
              <label className="block space-y-2">
                Reference PDF
                <input
                  className="block w-full"
                  type="file"
                  accept=".pdf"
                  onChange={(event) => setPdf(event.target.files?.[0] ?? null)}
                />
              </label>
              <Button
                variant="outline"
                disabled={!pdf || !associations.length || busy || stale}
                onClick={() => void upload(pdf, "pdf")}
              >
                Upload reference PDF
              </Button>
              <label className="block space-y-2">
                Structured reference JSON
                <input
                  className="block w-full"
                  type="file"
                  accept=".json"
                  onChange={(event) =>
                    setStructured(event.target.files?.[0] ?? null)
                  }
                />
              </label>
              <p className="text-muted-foreground">
                Maximum 3 MiB each. JSON version 1 must match the selected
                section and snapshot IDs.
              </p>
              <Button
                variant="outline"
                disabled={!structured || !associations.length || busy || stale}
                onClick={() => void upload(structured, "structured")}
              >
                Upload structured reference
              </Button>
            </fieldset>
            <DevelopmentExecution draft={draft} disabled={busy || stale || dirty} />
            <section
              aria-label="Saved documents"
              className="border-t border-border pt-5"
            >
              <h2 className="mb-3 font-semibold">Saved documents</h2>
              {!draft.documents.length && (
                <p className="text-muted-foreground">No documents saved.</p>
              )}
              <ul className="divide-y divide-border">
                {draft.documents.map((item) => (
                  <li key={item.id} className="py-3 break-words">
                    <p className="font-medium">{item.filename}</p>
                    <p className="text-muted-foreground">
                      {item.role === "source"
                        ? "Private source snapshot"
                        : `Evaluator-only · ${item.section ? sections[item.section] : "No section"} · ${item.review_status} · ${item.compatibility}`}
                    </p>
                    {item.role === "reference" && (
                      <p className="break-all text-xs text-muted-foreground">
                        Associated snapshots:{" "}
                        {item.source_document_ids.join(", ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
