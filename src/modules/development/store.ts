/** Additive experiment persistence; writes never touch customer schemas or settings. */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/lib/iegp/db";
import {
  DevelopmentError,
  type DevelopmentDocument,
  type Experiment,
} from "./schema";
const DDL = [
  `CREATE TABLE IF NOT EXISTS development_experiments (id text PRIMARY KEY, name text NOT NULL, source_workspace_id text, owner text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), status text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'), created_at text NOT NULL, updated_at text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS development_documents (id text PRIMARY KEY, experiment_id text NOT NULL REFERENCES development_experiments(id), record jsonb NOT NULL, content_base64 text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS development_documents_experiment ON development_documents(experiment_id)`,
];
let ready: Promise<void> | undefined;
async function ensureTables() {
  if (!ready)
    ready = (async () => {
      for (const ddl of DDL) await sharedDb().execute(sql.raw(ddl));
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
  await ready;
}
/** List draft summaries without loading immutable document contents. */
export async function listExperiments(): Promise<Experiment[]> {
  await ensureTables();
  const rows = await sharedDb().execute(
    sql`select * from development_experiments order by created_at desc`,
  );
  return (rows as unknown as Omit<Experiment, "documents">[]).map((row) => ({
    ...row,
    documents: [],
  }));
}
/** Create a draft bound permanently to at most one authorized workspace. */
export async function createExperiment(
  name: string,
  source_workspace_id: string | null,
  owner: string,
): Promise<Experiment> {
  await ensureTables();
  const id = randomUUID(),
    at = new Date().toISOString();
  await sharedDb().execute(
    sql`insert into development_experiments (id,name,source_workspace_id,owner,created_at,updated_at) values (${id},${name},${source_workspace_id},${owner},${at},${at})`,
  );
  return getExperiment(id);
}
/** Load a draft and its frozen source/reference metadata. */
export async function getExperiment(id: string): Promise<Experiment> {
  await ensureTables();
  const rows = await sharedDb().execute(
    sql`select * from development_experiments where id=${id}`,
  );
  if (!rows[0])
    throw new DevelopmentError(
      404,
      "not_found",
      "That experiment does not exist. Reopen it from the experiment list.",
    );
  const docs = await sharedDb().execute(
    sql`select record from development_documents where experiment_id=${id} order by id`,
  );
  return {
    ...rows[0],
    documents: docs.map((row) => row.record as DevelopmentDocument),
  } as Experiment;
}
/** Refuse stale browser state before potentially expensive preparation. */
export function requireRevision(
  experiment: Experiment,
  revision: number,
): void {
  if (experiment.revision !== revision)
    throw new DevelopmentError(
      409,
      "stale_revision",
      "This draft changed in another request. Reload it before saving or uploading again.",
    );
}
/** Atomically compare the revision, publish an optional immutable snapshot, and advance the draft. */
export async function updateExperiment(
  id: string,
  revision: number,
  update: {
    name?: string;
    document?: DevelopmentDocument;
    content_base64?: string;
  },
): Promise<Experiment> {
  await ensureTables();
  await sharedDb().transaction(async (tx) => {
    const rows = await tx.execute(
      sql`update development_experiments set name=coalesce(${update.name ?? null},name),revision=revision+1,updated_at=${new Date().toISOString()} where id=${id} and revision=${revision} returning id`,
    );
    if (!rows[0])
      throw new DevelopmentError(
        409,
        "stale_revision",
        "This draft changed in another request. Reload it before saving or uploading again.",
      );
    if (update.document)
      await tx.execute(
        sql`insert into development_documents (id,experiment_id,record,content_base64) values (${update.document.id},${id},${JSON.stringify(update.document)}::jsonb,${update.content_base64!})`,
      );
  });
  return getExperiment(id);
}
/** Retrieve immutable original bytes only within the requested experiment. */
export async function documentContent(
  id: string,
  documentId: string,
): Promise<{
  document: DevelopmentDocument;
  content_base64: string;
}> {
  await ensureTables();
  const rows = await sharedDb().execute(
    sql`select record,content_base64 from development_documents where experiment_id=${id} and id=${documentId}`,
  );
  if (!rows[0])
    throw new DevelopmentError(
      404,
      "not_found",
      "That document does not belong to this experiment.",
    );
  return {
    document: rows[0].record as DevelopmentDocument,
    content_base64: String(rows[0].content_base64),
  };
}

/** Initialize parent draft tables before additive execution-table installation. */
export { ensureTables as ensureDevelopmentTables };
