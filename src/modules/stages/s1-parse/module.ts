import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { curatedS1Cases } from "@/modules/eval-gold";
import { registerModule } from "@/modules/kernel/registry";
import type { SynapseModule } from "@/modules/kernel/contracts";
import { persistSourceAndBlocks } from "@/lib/iegp/store";
import {
  persistDroppedSourceUnits,
  recordLlmSourceStakeholder,
  reparseSourceBlocks,
} from "@/lib/iegp/source-blocks";
import * as iegp from "@/lib/iegp/schema";
import {
  extractCandidateGaps,
  extractCandidateTactics,
  splitSourceIntoBlocks,
} from "@/lib/iegp/engine";
import { parseLocalDocument } from "@/lib/ingest/local-parse";
import { parseWithLlm } from "@/lib/ingest/llm-structure";
import { isTestStub, requireLlm } from "@/modules/kernel/llm";
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

const PARSER_VERSION = "2.0.0";

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
    id: "s1-parse.llm",
    stage: "S1",
    version: "2.0.0",
    title: "LLM document parser",
    summary:
      "Extracts the text of PDF, PPTX, DOCX, XLSX and text files, then the chosen LLM decides the blocks, their kinds and headings. LlamaParse is disabled.",
    contract: 1,
    agentic: true,
    capabilities: ["pdf", "text", "docx", "pptx", "xlsx", "llm-structure"],
  },
  inputSchema,
  outputSchema,
  migrations: [PARSED_DOCUMENTS_DDL],
  async run(input, ctx) {
    requireLlm(ctx, "Parsing");
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
        // The model decides the structure; only the test stub splits text by rule.
        const parsed = await ctx.run.step(
          `parse:${file_id}`,
          async () => {
            if (isTestStub()) {
              const text =
                record.mime.startsWith("text/") || record.filename.endsWith(".txt")
                  ? buffer.toString("utf8")
                  : (await parseLocalDocument({ filename: record.filename, buffer, mime: record.mime })).blocks
                      .map((block) => block.text)
                      .join("\n\n");
              return {
                text,
                sections: undefined,
                parser: "local" as const,
                dropped_units: [],
                stakeholder: null,
              };
            }
            const { document, dropped, dropped_units, stakeholder_rationale } = await parseWithLlm({
              filename: record.filename,
              buffer,
              mime: record.mime,
              ask: ctx.complete,
            });
            if (dropped.length > 0) ctx.run.note(`parse:dropped:${file_id}`, dropped);
            return {
              text: document.blocks.map((block) => block.text).join("\n\n"),
              sections: document.blocks.map((block) => ({
                heading: block.heading ?? block.location.ref,
                text: block.text,
                location: block.location.ref,
              })),
              parser: "llm" as const,
              dropped_units,
              stakeholder: { stakeholder_function: document.stakeholder_function as string, rationale: stakeholder_rationale },
            };
          },
          record.mime,
        );
        const sectionsFor = () =>
          parsed.sections ??
          splitSourceIntoBlocks(parsed.text, record.title).map((section) => ({ ...section, location: section.heading }));
        if (input.dry_run) {
          // Score the parse without touching the domain store.
          const sections = sectionsFor();
          const quality = qualityOf(
            sections.map((section, index) => ({
              id: `dry-${index}`,
              source_id: "dry-run",
              heading: section.heading,
              text: section.text,
              location: section.location,
            })),
          );
          documents.push({
            id: `dry-${file_id}`,
            file_id,
            source_id: "dry-run",
            parser: parsed.parser,
            blocks: sections.length,
            quality,
          });
          ctx.run.note(`dry-parsed:${file_id}`, quality, `${sections.length} block(s), not persisted`);
          continue;
        }
        // Re-parsing a file that already has a source updates that source in
        // place: human-made and human-edited blocks survive, only model blocks
        // are replaced. A first parse creates the source.
        const existingSource = record.source_id
          ? (await db().select({ id: iegp.sources.id }).from(iegp.sources).where(eq(iegp.sources.id, record.source_id)))[0]
          : undefined;
        const { source_id, blocks } = existingSource
          ? await reparseSourceBlocks({ source_id: existingSource.id, sections: sectionsFor() }).then((result) => {
              if (result.kept_human > 0 || result.kept_cited > 0) {
                ctx.run.note(`parse:kept:${file_id}`, {
                  kept_human: result.kept_human,
                  kept_cited: result.kept_cited,
                  skipped_duplicates: result.skipped_duplicates,
                });
              }
              return result;
            })
          : await persistSourceAndBlocks({
              title: record.title,
              source_type: record.source_type as SourceType,
              stakeholder_function: record.stakeholder_function as ActorFunction,
              text: parsed.text,
              filename: record.filename,
              sections: parsed.sections,
            });
        await persistDroppedSourceUnits(source_id, parsed.dropped_units);
        if (parsed.stakeholder) {
          // Kept beside the source's function (chosen at upload or by a human override), never over it.
          await recordLlmSourceStakeholder({ source_id, ...parsed.stakeholder });
        }
        const quality = qualityOf(blocks);
        const id = newId("DOC");
        await db().insert(parsedDocuments).values({
          id,
          file_id,
          source_id,
          parser: parsed.parser,
          parser_version: PARSER_VERSION,
          blocks,
          quality,
          parsed_at: nowIso(),
          duration_ms: Date.now() - began,
        });
        await markFileParsed({ id: file_id, source_id, note: `${blocks.length} block(s)` });
        documents.push({ id, file_id, source_id, parser: parsed.parser, blocks: blocks.length, quality });
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
      const curated = await curatedS1Cases();
      if (curated.length > 0) return curated;
      const files = await listSourceFiles();
      return files.slice(0, 4).map((file) => ({
        name: file.filename,
        input: { file_ids: [file.id], dry_run: true },
      }));
    },
    score({ case: testCase, output }) {
      const documents = output.documents;
      const recovered = documents.filter((doc) => doc.quality.blocks > 0 && doc.quality.characters > 200);
      const withNeeds = documents.filter((doc) => doc.quality.need_cue_blocks > 0);
      const clean = documents.filter((doc) => doc.quality.warnings.length === 0);
      const doc = documents[0];
      const blocksOk =
        testCase.gold?.parse_min_blocks && doc
          ? doc.quality.blocks >= testCase.gold.parse_min_blocks
          : true;
      const cuesOk =
        testCase.gold?.parse_min_need_cues && doc
          ? doc.quality.need_cue_blocks >= testCase.gold.parse_min_need_cues
          : true;
      return [
        {
          name: "curated_parse_quality",
          value: blocksOk && cuesOk ? 1 : 0,
          unit: "ratio",
          target: testCase.gold?.parse_min_blocks ? 1 : undefined,
          detail: testCase.gold?.source_id ?? "workspace",
        },
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
