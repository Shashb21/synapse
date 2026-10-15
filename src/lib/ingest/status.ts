/** Read completed ingestion checkpoints for honest source status in the upload UI. */
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { ingestionJobs, INGESTION_JOBS_DDL } from "./schema";

/** Source references whose enabled ingestion steps have all completed. */
export async function completedIngestSourceIds(): Promise<Set<string>> {
  await ensurePlatformSchema([INGESTION_JOBS_DDL]);
  const jobs = await db().select().from(ingestionJobs);
  const ids = new Set<string>();
  for (const job of jobs) {
    const state = job.checkpoint as {
      completed: number;
      stages: string[];
      result: { source_ids: string[] };
    };
    if (state.completed === state.stages.length) {
      for (const id of state.result.source_ids) ids.add(id);
    }
  }
  return ids;
}
