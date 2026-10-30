import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { customerErrorMessage } from "@/modules/kernel/stage-errors";
/** Recoverable ingestion: each request commits at most one stage and its checkpoint. */
import { compareParsedSources } from "@/lib/ingest/compare-source";
import "@/modules";
import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { currentSchemaName, withWorkspaceTransaction } from "@/lib/iegp/db";
import { demoSourceById } from "@/lib/iegp/demo-pack";
import { tagStageError } from "@/modules/kernel/stage-errors";
import { ingestionJobs, INGESTION_JOBS_DDL } from "@/lib/ingest/schema";
import { uploadModule } from "@/modules/stages/s0-upload/module";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { ApiGuardError } from "@/modules/auth/api-guard";
import { aiSections, assertAiEnabled } from "@/modules/kernel/ai-switch";
import { sectionOfStage, type AiSections } from "@/modules/kernel/ai-sections";
import { runStage } from "@/modules/kernel/run";
import { isTestStub } from "@/modules/kernel/llm";
import { resolveRoute } from "@/modules/kernel/routing";
import { NoRouteError } from "@/modules/llm/provider";
import type { Actor, StageId } from "@/modules/kernel/contracts";
import type { Role } from "@/modules/auth/roles";
import type { ActorFunction, SourceType } from "@/lib/iegp/enums";

/** The judgement stages ingest runs. Each needs a connected LLM. */
const LLM_STAGES: StageId[] = ["S2", "S3", "S4"];

/** A source's content: pasted or text-file text, or a PDF/Office file as base64 with its mime (KAN-68). */
export type IngestPayload =
  | { filename: string; text: string; content_base64?: undefined; mime?: undefined }
  | { filename: string; content_base64: string; mime: string; text?: undefined };

export type IngestFile = IngestPayload & {
  title: string;
  source_type: SourceType;
  stakeholder_function: ActorFunction;
};

export type IngestResult = {
  source_ids: string[];
  gap_ids: string[];
  tactic_ids: string[];
  mapped_gap_ids: string[];
};

/**
 * Checks model routes before a new upload is saved. Runtime failures remain
 * recoverable at the last completed stage; nothing falls back to rules.
 */
async function requireLlmStages(sections: AiSections): Promise<void> {
  // The admin switch first: with ingestion off nothing is ingested; gaps and tactics are added by hand.
  await assertAiEnabled("Ingest", "ingestion");
  if (isTestStub()) return;
  for (const stage of LLM_STAGES) {
    // A stage whose section the admin turned off is skipped, so it needs no model (KAN-53).
    const section = sectionOfStage(stage);
    if (section && !sections[section]) continue;
    try {
      await resolveRoute(stage);
    } catch (error) {
      const reason = customerErrorMessage(error);
      throw new NoRouteError(
        `Ingest runs gap extraction (S2), tactic extraction (S3) and mapping (S4) on an LLM, and ${stage} has no connected model: ${reason}`,
      );
    }
  }
}

type Checkpoint = {
  request_key: string;
  stages: StageId[];
  completed: number;
  file_ids: string[];
  document_ids: string[];
  result: IngestResult;
};

export type IngestProgress = {
  job_id: string;
  done: boolean;
  stage: StageId | null;
  completed: number;
  total: number;
};

type IngestArgs = {
  files?: IngestFile[];
  demo_ids?: string[];
  actor: Actor;
  role: Role;
  job_id?: string;
};

/** Run or resume one ingestion stage, atomically saving its output and checkpoint. */
export async function advanceIngest(args: IngestArgs): Promise<IngestProgress> {
  const files = args.files ?? [];
  const demo_ids = args.demo_ids ?? [];
  uploadModule.inputSchema.parse({ files, demo_ids });
  if (!args.job_id && files.length === 0 && demo_ids.length === 0) throw new TrustedApplicationError("Choose a file or paste source text to import.");
  for (const file of files) {
    if (!file.title?.trim()) throw new TrustedApplicationError("A title is required.");
    if (!file.content_base64 && !file.text?.trim()) throw new TrustedApplicationError("Paste or drop the source text to ingest.");
  }
  // S0 identifies files by their bytes, so renaming the same upload must also
  // find its existing checkpoint rather than extracting its evidence twice.
  const contents = files.map((file) => file.content_base64
    ? Buffer.from(file.content_base64, "base64") : Buffer.from(file.text ?? "", "utf8"));
  for (const id of demo_ids) {
    const demo = demoSourceById(id);
    if (!demo) throw new ApiGuardError(400, "invalid_request", "Unknown demo source.");
    contents.push(Buffer.from(demo.text, "utf8"));
  }
  const checksums = [...new Set(contents.map((content) => createHash("sha256").update(content).digest("hex")))].sort();
  const request_key = createHash("sha256").update(JSON.stringify(checksums)).digest("hex");
  // A retry can find the same payload, but a deleted job token is never reused.
  let job_id = args.job_id ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(job_id)) throw new ApiGuardError(400, "invalid_request", "Invalid ingestion reference.");
  await ensurePlatformSchema([INGESTION_JOBS_DDL]);
  const schema = await currentSchemaName();
  let comparisonSources: string[] = [];
  const progress = await withWorkspaceTransaction(async () => {
    // A transaction lock is released even if a worker dies. No expiring lease can
    // let a slow model call overlap with a retry. Scope includes the workspace.
    const locked = await db().execute(sql`
      select pg_try_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0)) as locked
    `);
    if (!locked[0]?.locked) throw new ApiGuardError(409, "ingest_busy", "An ingestion step is still running. Wait for it to finish, then retry.");
    const [saved] = await db().select().from(ingestionJobs).where(args.job_id
      ? eq(ingestionJobs.id, job_id)
      : sql`${ingestionJobs.checkpoint}->>'request_key' = ${request_key}`).for("update");
    if (!saved && args.job_id) throw new ApiGuardError(400, "invalid_request", "Ingestion not found. Select the file and try again.");
    let state: Checkpoint;
    if (saved) {
      job_id = saved.id;
      state = saved.checkpoint as Checkpoint;
    } else {
      const sections = await aiSections();
      await requireLlmStages(sections);
      state = {
        request_key,
        stages: [
          "S0", "S1",
          ...(sections.gap_extraction ? ["S2" as const] : []),
          ...(sections.tactic_extraction ? ["S3" as const] : []),
          ...(sections.mapping ? ["S4" as const] : []),
        ],
        completed: 0,
        file_ids: [],
        document_ids: [],
        result: { source_ids: [], gap_ids: [], tactic_ids: [], mapped_gap_ids: [] },
      };
    }
    const stage = state.stages[state.completed];
    const run = <O>(input: unknown) => runStage<O>({ stage, input, actor: args.actor, role: args.role });
    try {
      if (stage === "S0") {
        const upload = await run<{ files: { id: string }[] }>({ files, demo_ids, reuse_existing: true });
        state.file_ids = [...new Set(upload.output.files.map((file) => file.id))];
        if (!state.file_ids.length) throw new TrustedApplicationError("Nothing was ingested. Choose a non-empty file.");
      } else if (stage === "S1") {
        const existing = (await listParsedDocuments()).filter((doc) => state.file_ids.includes(doc.file_id));
        const missing = state.file_ids.filter((id) => !existing.some((doc) => doc.file_id === id));
        const parse = missing.length ? await run<{
          documents: { id: string; source_id: string }[];
          failures: { file_id: string; reason: string }[];
        }>({ file_ids: missing }) : null;
        if (parse?.output.failures.length) {
          throw new TrustedApplicationError("Parsing failed. The uploaded files remain registered. Check the file format and retry parsing from this checkpoint; do not upload the files again.");
        }
        const documents = [...existing, ...(parse?.output.documents ?? [])];
        if (!documents.length) throw new TrustedApplicationError("Parsing produced no documents. Try again.");
        state.document_ids = documents.map((doc) => doc.id);
        state.result.source_ids = documents.map((doc) => doc.source_id);
        comparisonSources = state.result.source_ids;
      } else if (stage === "S2") {
        const gaps = await run<{ committed_gap_ids: string[] }>({ document_ids: state.document_ids });
        state.result.gap_ids = gaps.output.committed_gap_ids;
      } else if (stage === "S3") {
        const tactics = await run<{ committed_tactic_ids: string[] }>({ document_ids: state.document_ids });
        state.result.tactic_ids = tactics.output.committed_tactic_ids;
      } else if (stage === "S4") {
        const mapping = await run<{ committed: { gap_id: string }[] }>({});
        state.result.mapped_gap_ids = mapping.output.committed.map((row) => row.gap_id);
      }
    } catch (error) {
      if (stage) tagStageError(error, stage);
      throw error;
    }
    if (stage) {
      state.completed++;
      await db().insert(ingestionJobs)
        .values({ id: job_id, checkpoint: state })
        .onConflictDoUpdate({ target: ingestionJobs.id, set: { checkpoint: state } });
    }
    return {
      job_id,
      done: state.completed === state.stages.length,
      stage: state.stages[state.completed] ?? null,
      completed: state.completed,
      total: state.stages.length,
    };
  });
  // Comparison failure cannot roll back a successfully committed parse checkpoint.
  await compareParsedSources(comparisonSources, args.actor);
  return progress;
}

/** Compatibility entry point for callers that need the complete pipeline result. */
export async function ingestThroughStages(args: IngestArgs): Promise<IngestResult> {
  let progress = await advanceIngest(args);
  while (!progress.done) progress = await advanceIngest({ ...args, job_id: progress.job_id });
  const [saved] = await db().select().from(ingestionJobs).where(eq(ingestionJobs.id, progress.job_id));
  if (!saved) throw new ApiGuardError(400, "invalid_request", "Ingestion not found. Select the file and try again.");
  return (saved.checkpoint as Checkpoint).result;
}
