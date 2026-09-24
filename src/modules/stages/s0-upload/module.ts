import { createHash } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import type { SynapseModule } from "@/modules/kernel/contracts";
import { ACTOR_FUNCTIONS, SOURCE_TYPES } from "@/lib/iegp/enums";
import { DEMO_PACK, demoSourceById } from "@/lib/iegp/demo-pack";
import { mimeForFilename } from "@/lib/ingest/local-parse";
import { SOURCE_FILES_DDL, sourceFiles } from "./schema";

const fileInput = z.object({
  filename: z.string().min(1),
  title: z.string().min(1),
  source_type: z.enum(SOURCE_TYPES),
  stakeholder_function: z.enum(ACTOR_FUNCTIONS),
  /** Plain text payload, or base64 for binary office formats. */
  text: z.string().optional(),
  content_base64: z.string().optional(),
  mime: z.string().optional(),
});

const inputSchema = z.object({
  files: z.array(fileInput).default([]),
  /** Ids from the bundled demo pack, uploaded as if the user had picked them. */
  demo_ids: z.array(z.string()).default([]),
});

const outputSchema = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      title: z.string(),
      source_type: z.string(),
      stakeholder_function: z.string(),
      mime: z.string(),
      bytes: z.number(),
      checksum: z.string(),
      uploaded_at: z.string(),
      duplicate_of: z.string().nullable(),
    }),
  ),
  skipped: z.array(z.object({ filename: z.string(), reason: z.string() })),
});

export type UploadInput = z.infer<typeof inputSchema>;
export type UploadOutput = z.infer<typeof outputSchema>;

export type SourceFileRecord = {
  id: string;
  filename: string;
  title: string;
  source_type: string;
  stakeholder_function: string;
  mime: string;
  bytes: number;
  checksum: string;
  status: string;
  uploaded_by: string;
  uploaded_at: string;
  parsed_at: string | null;
  source_id: string | null;
  note: string | null;
};

/** File metadata without the stored bytes, which no caller outside S1 needs. */
function withoutContent(row: typeof sourceFiles.$inferSelect): SourceFileRecord {
  return {
    id: row.id,
    filename: row.filename,
    title: row.title,
    source_type: row.source_type,
    stakeholder_function: row.stakeholder_function,
    mime: row.mime,
    bytes: row.bytes,
    checksum: row.checksum,
    status: row.status,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
    parsed_at: row.parsed_at,
    source_id: row.source_id,
    note: row.note,
  };
}

function checksumOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

export const uploadModule: SynapseModule<UploadInput, UploadOutput> = {
  manifest: {
    id: "s0-upload.local-store",
    stage: "S0",
    version: "1.0.0",
    title: "Local upload store",
    summary: "Records uploaded files with checksum and mime. No parsing, no extraction.",
    contract: 1,
    agentic: false,
    // Uploads only feed the AI parser; with AI off, gaps and tactics are added by hand.
    needs_ai: true,
    capabilities: ["text", "docx", "pptx", "xlsx", "demo-pack"],
  },
  inputSchema,
  outputSchema,
  migrations: [SOURCE_FILES_DDL],
  async run(input, ctx) {
    const existing = await db().select().from(sourceFiles);
    const requested: z.infer<typeof fileInput>[] = [
      ...input.files,
      ...input.demo_ids.map((id) => {
        const demo = demoSourceById(id);
        if (!demo) throw new Error(`Unknown demo source ${id}`);
        return {
          filename: demo.filename,
          title: demo.title,
          source_type: demo.source_type,
          stakeholder_function: demo.stakeholder_function,
          text: demo.text,
          mime: "text/plain",
        };
      }),
    ];
    const accepted: UploadOutput["files"] = [];
    const skipped: UploadOutput["skipped"] = [];

    for (const file of requested) {
      const buffer = file.content_base64
        ? Buffer.from(file.content_base64, "base64")
        : Buffer.from(file.text ?? "", "utf8");
      if (buffer.length === 0) {
        skipped.push({ filename: file.filename, reason: "empty file" });
        continue;
      }
      const checksum = checksumOf(buffer);
      const duplicate = existing.find((row) => row.checksum === checksum);
      if (duplicate) {
        skipped.push({ filename: file.filename, reason: `identical to ${duplicate.id}` });
        continue;
      }
      const id = `FILE-${checksum.slice(0, 10)}`;
      const uploaded_at = nowIso();
      const record = {
        id,
        workspace_id: ctx.workspace_id,
        filename: file.filename,
        title: file.title,
        source_type: file.source_type,
        stakeholder_function: file.stakeholder_function,
        mime: file.mime ?? mimeForFilename(file.filename),
        bytes: buffer.length,
        checksum,
        content_base64: buffer.toString("base64"),
        status: "uploaded",
        uploaded_by: ctx.actor.name,
        uploaded_at,
        parsed_at: null,
        source_id: null,
        note: null,
      };
      await db().insert(sourceFiles).values(record).onConflictDoNothing();
      accepted.push({
        id,
        filename: record.filename,
        title: record.title,
        source_type: record.source_type,
        stakeholder_function: record.stakeholder_function,
        mime: record.mime,
        bytes: record.bytes,
        checksum,
        uploaded_at,
        duplicate_of: null,
      });
      ctx.run.note("file:accepted", { id, bytes: buffer.length, mime: record.mime });
    }

    for (const item of skipped) ctx.run.note("file:skipped", item);

    return {
      output: { files: accepted, skipped },
      summary: `${accepted.length} file(s) uploaded, ${skipped.length} skipped`,
      evals: [
        { name: "files_accepted", value: accepted.length, unit: "count" },
        {
          name: "accept_rate",
          value: requested.length === 0 ? 0 : Number((accepted.length / requested.length).toFixed(3)),
          unit: "ratio",
        },
      ],
    };
  },
};

registerModule(uploadModule);

export async function listSourceFiles(): Promise<SourceFileRecord[]> {
  await ensurePlatformSchema([SOURCE_FILES_DDL]);
  const rows = await db().select().from(sourceFiles).orderBy(desc(sourceFiles.uploaded_at));
  return rows.map(withoutContent);
}

export async function sourceFileContent(id: string): Promise<{ record: SourceFileRecord; buffer: Buffer } | null> {
  await ensurePlatformSchema([SOURCE_FILES_DDL]);
  const rows = await db().select().from(sourceFiles).where(eq(sourceFiles.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return { record: withoutContent(row), buffer: Buffer.from(row.content_base64, "base64") };
}

export async function markFileParsed(args: { id: string; source_id: string; note?: string }) {
  await db()
    .update(sourceFiles)
    .set({ status: "parsed", parsed_at: nowIso(), source_id: args.source_id, note: args.note ?? null })
    .where(eq(sourceFiles.id, args.id));
}

export async function markFileFailed(args: { id: string; note: string }) {
  await db().update(sourceFiles).set({ status: "error", note: args.note }).where(eq(sourceFiles.id, args.id));
}

export async function unparsedFileIds(): Promise<string[]> {
  await ensurePlatformSchema([SOURCE_FILES_DDL]);
  const rows = await db().select().from(sourceFiles).where(eq(sourceFiles.status, "uploaded"));
  return rows.map((row) => row.id);
}

export async function filesByIds(ids: string[]): Promise<SourceFileRecord[]> {
  if (ids.length === 0) return [];
  const rows = await db().select().from(sourceFiles).where(inArray(sourceFiles.id, ids));
  return rows.map(withoutContent);
}

export const DEMO_FILE_OPTIONS = DEMO_PACK.map((file) => ({
  id: file.id,
  title: file.title,
  filename: file.filename,
  source_type: file.source_type,
  stakeholder_function: file.stakeholder_function,
}));
