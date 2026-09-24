import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { isTestStub } from "@/modules/kernel/llm";
import { resolveRoute } from "@/modules/kernel/routing";
import type { Actor, StageId } from "@/modules/kernel/contracts";
import type { Role } from "@/modules/auth/roles";
import type { ActorFunction, SourceType } from "@/lib/iegp/enums";

/** The judgement stages ingest runs. Each needs a connected LLM. */
const LLM_STAGES: StageId[] = ["S2", "S3", "S4"];

export type IngestFile = {
  filename: string;
  title: string;
  source_type: SourceType;
  stakeholder_function: ActorFunction;
  text: string;
};

export type IngestResult = {
  source_ids: string[];
  gap_ids: string[];
  tactic_ids: string[];
  mapped_gap_ids: string[];
};

/**
 * Refuses before anything is written when a judgement stage cannot reach a
 * model, so a source is never half-ingested and nothing falls back to rules.
 */
async function requireLlmStages(): Promise<void> {
  if (isTestStub()) return;
  for (const stage of LLM_STAGES) {
    try {
      await resolveRoute(stage);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Ingest runs gap extraction (S2), tactic extraction (S3) and mapping (S4) on an LLM, and ${stage} has no connected model: ${reason}`,
      );
    }
  }
}

/**
 * Ingest is the stage pipeline, in order: S0 upload → S1 parse → S2 gap
 * extraction → S3 tactic extraction → S4 mapping. Every judgement (what is a
 * gap, what is a tactic, what repeats an existing record, what covers what) is
 * made by those LLM stages; this function only sequences them.
 */
export async function ingestThroughStages(args: {
  files?: IngestFile[];
  demo_ids?: string[];
  actor: Actor;
  role: Role;
}): Promise<IngestResult> {
  const files = args.files ?? [];
  const demo_ids = args.demo_ids ?? [];
  if (files.length === 0 && demo_ids.length === 0) throw new Error("Nothing to ingest.");
  for (const file of files) {
    if (!file.title?.trim()) throw new Error("A title is required.");
    if (!file.text?.trim()) throw new Error("Paste or drop the source text to ingest.");
  }
  await requireLlmStages();
  const run = <O>(stage: StageId, input: unknown) =>
    runStage<O>({ stage, input, actor: args.actor, role: args.role });

  const upload = await run<{
    files: { id: string }[];
    skipped: { filename: string; reason: string }[];
  }>("S0", { files, demo_ids });
  if (upload.output.files.length === 0) {
    const why = upload.output.skipped.map((row) => `${row.filename}: ${row.reason}`).join("; ");
    throw new Error(why ? `Nothing was ingested. ${why}` : "Nothing was ingested.");
  }

  const parse = await run<{
    documents: { id: string; source_id: string }[];
    failures: { file_id: string; reason: string }[];
  }>("S1", { file_ids: upload.output.files.map((file) => file.id) });
  if (parse.output.failures.length > 0) {
    throw new Error(
      `Parsing failed: ${parse.output.failures.map((row) => `${row.file_id}: ${row.reason}`).join("; ")}`,
    );
  }
  const document_ids = parse.output.documents.map((document) => document.id);

  const gaps = await run<{ committed_gap_ids: string[] }>("S2", { document_ids });
  const tactics = await run<{ committed_tactic_ids: string[] }>("S3", { document_ids });
  const mapping = await run<{ committed: { gap_id: string }[] }>("S4", {});

  return {
    source_ids: parse.output.documents.map((document) => document.source_id),
    gap_ids: gaps.output.committed_gap_ids,
    tactic_ids: tactics.output.committed_tactic_ids,
    mapped_gap_ids: mapping.output.committed.map((row) => row.gap_id),
  };
}
