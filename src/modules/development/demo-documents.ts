/** Bundled client demo files as private experiment sources; no demo results are imported. */
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { prepareSource, sha256 } from "./documents";
import { DevelopmentError, type Experiment } from "./schema";

export type DemoDocumentSummary = {
  id: string;
  title: string;
  filename: string;
  /** True when the experiment already holds this file, by demo identity or original bytes. */
  present: boolean;
};

/** Already saved by demo identity, or by identical original bytes added without demo provenance. */
function isPresent(experiment: Experiment, file: { id: string; text: string }): boolean {
  const hash = sha256(Buffer.from(file.text, "utf8"));
  return experiment.documents.some(
    (item) => item.role === "source" && (item.demo?.id === file.id || item.sha256 === hash),
  );
}

/** List the allowlisted demo files by metadata and per-experiment presence only. */
export function listDemoDocuments(experiment: Experiment): DemoDocumentSummary[] {
  return CLIENT_DEMO_PACK.map((file) => ({
    id: file.id,
    title: file.title,
    filename: file.filename,
    present: isPresent(experiment, file),
  }));
}

/**
 * Prepare one bundled demo file as a private source of the experiment.
 *
 * Parameters
 * ----------
 * experiment : Experiment
 *     Current draft; duplicates are detected against its saved sources.
 * actor : string
 *     Owner recorded as the document creator.
 * demoId : string
 *     Identifier resolved server-side against the bundled client demo files.
 *
 * Returns
 * -------
 * The prepared document and original bytes, ready for updateExperiment.
 *
 * Raises
 * ------
 * DevelopmentError
 *     404 unknown_demo_document for ids outside the bundle; 409
 *     duplicate_demo_document before any AI call when already saved.
 */
export async function prepareDemoDocument(
  experiment: Experiment,
  actor: string,
  demoId: string,
) {
  const file = CLIENT_DEMO_PACK.find((item) => item.id === demoId);
  if (!file)
    throw new DevelopmentError(
      404,
      "unknown_demo_document",
      "That demo file is not available. Choose one of the listed demo files.",
    );
  if (isPresent(experiment, file))
    throw new DevelopmentError(
      409,
      "duplicate_demo_document",
      "That demo file is already in this experiment.",
    );
  const buffer = Buffer.from(file.text, "utf8");
  const prepared = await prepareSource(
    experiment,
    actor,
    file.filename,
    buffer.toString("base64"),
  );
  return {
    ...prepared,
    document: { ...prepared.document, demo: { pack: "client-demo" as const, id: file.id } },
  };
}
