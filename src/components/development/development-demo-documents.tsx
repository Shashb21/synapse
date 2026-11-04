/** Multi-select of bundled demo files; each file is prepared and saved by its own request. */
"use client";

import { developmentStyles as styles } from "./development-styles";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Experiment } from "@/modules/development/schema";

type DemoFile = { id: string; title: string; filename: string; present: boolean };
type Outcome = { status: "saved" | "failed"; message: string };
type Props = {
  draft: Experiment;
  /** Parent's serialized runner; it holds the busy lock and aborts on unmount. */
  perform: (label: string, action: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  accept: (experiment: Experiment) => void;
};
const root = "/api/admin/development";

/** Read one saved experiment so revision and saved sources are authoritative. */
async function fetchExperiment(id: string, signal: AbortSignal): Promise<Experiment | null> {
  try {
    const response = await fetch(`${root}/${id}`, { signal, cache: "no-store" });
    return response.ok ? ((await response.json()) as { experiment: Experiment }).experiment : null;
  } catch {
    return null;
  }
}

/** Choose bundled demo files and add them as private, fixed-copy sources. */
export function DevelopmentDemoDocuments({ draft, perform, accept }: Props) {
  const [files, setFiles] = useState<DemoFile[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped by the retry button so discovery reruns without changing the draft revision.
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [progress, setProgress] = useState("");
  // Server-reported presence also covers identical bytes saved earlier without demo provenance.
  const saved = new Set([
    ...draft.documents.flatMap(item => (item.demo ? [item.demo.id] : [])),
    ...files.filter(file => file.present).map(file => file.id),
  ]);
  const pending = selected.filter(id => !saved.has(id));

  useEffect(() => {
    const active = new AbortController();
    fetch(`${root}/${draft.id}/demo-documents`, { signal: active.signal, cache: "no-store" })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((body: { documents: DemoFile[] }) => {
        setFiles(body.documents);
        setLoadFailed(false);
      })
      .catch(() => { if (!active.signal.aborted) setLoadFailed(true); });
    return () => active.abort();
  }, [draft.id, draft.revision, discoveryAttempt]);

  /** Save one file; ambiguous failures are resolved by re-reading the saved draft. */
  async function addOne(file: DemoFile, current: Experiment, signal: AbortSignal): Promise<{ experiment: Experiment; outcome: Outcome }> {
    let message = "Could not add this file. Retry it.";
    try {
      const response = await fetch(`${root}/${current.id}/demo-documents`, {
        method: "POST", signal, cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: current.revision, demo_id: file.id }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.experiment) return { experiment: body.experiment, outcome: { status: "saved", message: "Saved" } };
      if (typeof body?.error === "string") message = body.error;
      if (body?.code === "duplicate_demo_document") {
        // Already saved (possibly without demo provenance): satisfied, not a failure.
        setFiles(previous => previous.map(item => (item.id === file.id ? { ...item, present: true } : item)));
        return { experiment: (await fetchExperiment(current.id, signal)) ?? current, outcome: { status: "saved", message: "Already added" } };
      }
      if (body?.code === "stale_revision") message = "The draft changed while adding this file. It has been refreshed; retry it.";
    } catch {
      message = "Unable to connect. Check your connection and retry this file.";
    }
    const fresh = await fetchExperiment(current.id, signal);
    if (fresh?.documents.some(item => item.demo?.id === file.id))
      return { experiment: fresh, outcome: { status: "saved", message: "Saved" } };
    return { experiment: fresh ?? current, outcome: { status: "failed", message } };
  }

  async function addSelected() {
    const queue = files.filter(file => pending.includes(file.id));
    await perform("Preparing demo documents…", async signal => {
      let current = draft;
      const results: Record<string, Outcome> = {};
      for (const [index, file] of queue.entries()) {
        setProgress(`Preparing ${index + 1} of ${queue.length}: ${file.title}…`);
        const result = await addOne(file, current, signal);
        if (signal.aborted) return;
        current = result.experiment;
        accept(current);
        results[file.id] = result.outcome;
        setOutcomes(previous => ({ ...previous, ...results }));
      }
      setProgress("");
      setSelected(previous => previous.filter(id => results[id]?.status !== "saved"));
      const failed = Object.values(results).filter(item => item.status === "failed").length;
      if (failed) throw new Error(`${failed} of ${queue.length} demo files could not be added. Successful files were kept; retry the remaining selection.`);
    });
    setProgress("");
  }

  return (
    <div className="min-w-0 space-y-3" aria-labelledby="demo-heading" role="group">
      <h4 id="demo-heading" className={styles.subsection}>Demo files</h4>
      <p className={styles.explanation}>
        Add the bundled Velmara demo documents as private, fixed copies. Each file is parsed with the configured AI ingestion route, which can incur AI charges. Ingestion must be enabled in /admin/control.
      </p>
      {loadFailed && (
        <div role="alert" className="space-y-1">
          <p>Demo files could not be loaded.</p>
          <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" onClick={() => setDiscoveryAttempt(attempt => attempt + 1)}>
            Retry loading demo files
          </Button>
        </div>
      )}
      <ul className="space-y-3">
        {files.map(file => {
          const added = saved.has(file.id), outcome = outcomes[file.id];
          return (
            <li key={file.id} className="[overflow-wrap:anywhere]">
              <label className="flex min-w-0 items-start gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={added || selected.includes(file.id)}
                  disabled={added}
                  onChange={event => setSelected(current => event.target.checked ? [...current, file.id] : current.filter(id => id !== file.id))}
                />
                <span className="min-w-0">
                  {file.title} <span className={styles.explanation}>({file.filename})</span>
                  {added ? <span className={styles.explanation}> · Already added</span> : outcome?.status === "failed" ? <span> · Not added: {outcome.message}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p id="demo-selection-reason" role="status">
        {progress || (pending.length ? `${pending.length} demo ${pending.length === 1 ? "file" : "files"} selected to add.` : "Select demo files to add.")}
      </p>
      <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" aria-describedby="demo-selection-reason" disabled={!pending.length} onClick={() => void addSelected()}>
        Add selected demo files
      </Button>
    </div>
  );
}
