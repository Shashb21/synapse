import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import type { SynapseModule } from "@/modules/kernel/contracts";
import { persistSourceAndBlocks } from "@/lib/iegp/store";
import {
  extractCandidateGaps,
  extractCandidateTactics,
  splitSourceIntoBlocks,
} from "@/lib/iegp/engine";
import { parseLocalDocument } from "@/lib/ingest/local-parse";
import type { ActorFunction, SourceType } from "@/lib/iegp/enums";
import {
  listSourceFiles,
  markFileFailed,
  markFileParsed,
  sourceFileContent,
  unparsedFileIds,
} from "@/modules/stages/s0-upload/module";
import {
  PARSED_DOCUMENTS_DDL,
  parsedDocuments,
  type ParseQuality,
  type ParsedDocumentBlock,
} from "./schema";

const inputSchema = z.object({
  /** Defaults to every uploaded file that has not been parsed yet. */
  file_ids: z.array(z.string()).optional(),
  /** Parse and score quality without writing the domain source. Used by evals. */
  dry_run: z.boolean().default(false),
});

const outputSchema = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      file_id: z.string(),
      source_id: z.string(),
      parser: z.string(),
      blocks: z.number(),
      quality: z.object({
        blocks: z.number(),
        characters: z.number(),
        avg_block_chars: z.number(),
        empty_blocks: z.number(),
        need_cue_blocks: z.number(),
        tactic_cue_blocks: z.number(),
        warnings: z.array(z.string()),
      }),
    }),
  ),
  failures: z.array(z.object({ file_id: z.string(), reason: z.string() })),
});

export type ParseInput = z.infer<typeof inputSchema>;
export type ParseOutput = z.infer<typeof outputSchema>;

const PARSER_VERSION = "1.0.0";

function qualityOf(blocks: ParsedDocumentBlock[]): ParseQuality {
  const characters = blocks.reduce((sum, block) => sum + block.text.length, 0);
  const cueBlocks = extractCandidateGaps(blocks).map((gap) => gap.source_id);
  const tacticBlocks = extractCandidateTactics(blocks).map((tactic) => tactic.source_id);
  const warnings: string[] = [];
  if (blocks.length === 0) warnings.push("no blocks recovered");
  if (characters < 200) warnings.push("very little text recovered");
  if (cueBlocks.length === 0) warnings.push("no evidence-need language detected");
  return {
    blocks: blocks.length,
    characters,
    avg_block_chars: blocks.length === 0 ? 0 : Math.round(characters / blocks.length),
    empty_blocks: blocks.filter((block) => block.text.trim().length === 0).length,
    need_cue_blocks: cueBlocks.length,
    tactic_cue_blocks: tacticBlocks.length,
    warnings,
  };
}

export const parseModule: SynapseModule<ParseInput, ParseOutput> = {
  manifest: {
    id: "s1-parse.local",
    stage: "S1",
    version: "1.0.0",
    title: "Local document parser",
    summary:
      "Parses text, DOCX, PPTX and XLSX into headed blocks, writes the domain source, and scores parse quality.",
    contract: 1,
    agentic: false,
    capabilities: ["text", "docx", "pptx", "xlsx"],
  },
  inputSchema,
  outputSchema,
  migrations: [PARSED_DOCUMENTS_DDL],
  async run(input, ctx) {
    const ids = input.file_ids?.length
      ? input.file_ids
      : input.dry_run
        ? (await listSourceFiles()).map((file) => file.id)
        : await unparsedFileIds();
    const documents: ParseOutput["documents"] = [];
    const failures: ParseOutput["failures"] = [];

    for (const file_id of ids) {
      const loaded = await sourceFileContent(file_id);
      if (!loaded) {
        failures.push({ file_id, reason: "file not found" });
        continue;
      }
      const began = Date.now();
      try {
        const { record, buffer } = loaded;
        const text = await ctx.run.step(
          `extract-text:${file_id}`,
          async () => {
            if (record.mime.startsWith("text/") || record.filename.endsWith(".txt")) {
              return buffer.toString("utf8");
            }
            const parsed = await parseLocalDocument({
              filename: record.filename,
              buffer,
              mime: record.mime,
            });
            return parsed.blocks.map((block) => block.text).join("\n\n");
          },
          record.mime,
        );
        if (input.dry_run) {
          // Score the parse without touching the domain store.
          const sections = splitSourceIntoBlocks(text, record.title);
          const quality = qualityOf(
            sections.map((section, index) => ({
              id: `dry-${index}`,
              source_id: "dry-run",
              heading: section.heading,
              text: section.text,
              location: section.heading,
            })),
          );
          documents.push({
            id: `dry-${file_id}`,
            file_id,
            source_id: "dry-run",
            parser: "local",
            blocks: sections.length,
            quality,
          });
          ctx.run.note(`dry-parsed:${file_id}`, quality, `${sections.length} block(s), not persisted`);
          continue;
        }
        const { source_id, blocks } = await persistSourceAndBlocks({
          title: record.title,
          source_type: record.source_type as SourceType,
          stakeholder_function: record.stakeholder_function as ActorFunction,
          text,
          filename: record.filename,
        });
        const quality = qualityOf(blocks);
        const id = newId("DOC");
        await db().insert(parsedDocuments).values({
          id,
          file_id,
          source_id,
          parser: "local",
          parser_version: PARSER_VERSION,
          blocks,
          quality,
          parsed_at: nowIso(),
          duration_ms: Date.now() - began,
        });
        await markFileParsed({ id: file_id, source_id, note: `${blocks.length} block(s)` });
        documents.push({ id, file_id, source_id, parser: "local", blocks: blocks.length, quality });
        ctx.run.note(`parsed:${file_id}`, quality, `${blocks.length} block(s) → ${source_id}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await markFileFailed({ id: file_id, note: reason });
        failures.push({ file_id, reason });
        ctx.run.note(`parse-failed:${file_id}`, { reason });
      }
    }

    const cueRatio =
      documents.length === 0
        ? 0
        : documents.filter((doc) => doc.quality.need_cue_blocks > 0).length / documents.length;

    return {
      output: { documents, failures },
      summary: `${documents.length} document(s) parsed, ${failures.length} failed`,
      evals: [
        { name: "documents_parsed", value: documents.length, unit: "count" },
        { name: "with_need_language", value: Number(cueRatio.toFixed(3)), unit: "ratio", target: 0.5 },
        {
          name: "parse_success_rate",
          value: ids.length === 0 ? 0 : Number((documents.length / ids.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
      ],
      signals: documents
        .filter((doc) => doc.quality.warnings.length > 0)
        .map((doc) => ({
          stage: "S1" as const,
          kind: "parse_quality" as const,
          subject: `document:${doc.id}`,
          rationale: doc.quality.warnings.join("; "),
          payload: doc.quality,
        })),
    };
  },
  evals: {
    async cases() {
      const files = await listSourceFiles();
      return files.slice(0, 4).map((file) => ({
        name: file.filename,
        input: { file_ids: [file.id], dry_run: true },
      }));
    },
    score({ output }) {
      const documents = output.documents;
      const recovered = documents.filter((doc) => doc.quality.blocks > 0 && doc.quality.characters > 200);
      const withNeeds = documents.filter((doc) => doc.quality.need_cue_blocks > 0);
      const clean = documents.filter((doc) => doc.quality.warnings.length === 0);
      return [
        {
          name: "text_recovered",
          value: documents.length === 0 ? 0 : Number((recovered.length / documents.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        {
          name: "need_language_found",
          value: documents.length === 0 ? 0 : Number((withNeeds.length / documents.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        {
          name: "warning_free",
          value: documents.length === 0 ? 0 : Number((clean.length / documents.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
      ];
    },
  },
};

registerModule(parseModule);

export type ParsedDocumentRecord = {
  id: string;
  file_id: string;
  source_id: string;
  parser: string;
  parser_version: string;
  blocks: ParsedDocumentBlock[];
  quality: ParseQuality;
  parsed_at: string;
  duration_ms: number;
};

function toRecord(row: typeof parsedDocuments.$inferSelect): ParsedDocumentRecord {
  return {
    id: row.id,
    file_id: row.file_id,
    source_id: row.source_id,
    parser: row.parser,
    parser_version: row.parser_version,
    blocks: row.blocks as ParsedDocumentBlock[],
    quality: row.quality as ParseQuality,
    parsed_at: row.parsed_at,
    duration_ms: row.duration_ms,
  };
}

export async function listParsedDocuments(ids?: string[]): Promise<ParsedDocumentRecord[]> {
  await ensurePlatformSchema([PARSED_DOCUMENTS_DDL]);
  if (ids?.length) {
    const rows = await db().select().from(parsedDocuments).where(inArray(parsedDocuments.id, ids));
    return rows.map(toRecord);
  }
  const rows = await db().select().from(parsedDocuments).orderBy(desc(parsedDocuments.parsed_at));
  return rows.map(toRecord);
}

export async function parsedDocument(id: string): Promise<ParsedDocumentRecord | null> {
  await ensurePlatformSchema([PARSED_DOCUMENTS_DDL]);
  const rows = await db().select().from(parsedDocuments).where(eq(parsedDocuments.id, id)).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}
