import { z } from "zod";
import {
  blocksFromParsedDocument,
  persistParseBlocks,
} from "@/accuracy/store/parse-store";
import { agenticModule } from "../_factory";
import { completeJson, requireAccuracyLlm } from "../../kernel/routing";
import { ingestFile } from "./ingest-file";
import { resolveParsePolicy } from "./parse-policy";

const inputSchema = z.object({
  workspace_id: z.string(),
  source_file_id: z.string(),
  filename: z.string(),
  mime: z.string(),
  content_base64: z.string(),
});

const outputSchema = z.object({
  parser: z.enum(["llm", "local_structured"]),
  reason: z.string(),
  block_count: z.number().int().nonnegative(),
  /** Units the model judged to be noise, with its reason. */
  dropped: z.array(z.object({ location: z.string(), reason: z.string() })),
});

export const parseModule = agenticModule({
  id: "parse.llm-v1",
  call_kind: "parse",
  title: "LLM parse",
  summary: "Extract the file's text, then the chosen LLM decides blocks, kinds and headings. LlamaParse is disabled.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    requireAccuracyLlm(ctx.route, "Parsing");
    const policy = resolveParsePolicy({ filename: input.filename, mime: input.mime });
    ctx.run.note("parse:policy", policy);

    const buffer = Buffer.from(input.content_base64, "base64");
    if (buffer.length === 0) {
      throw new Error("parse: empty content_base64");
    }

    const ingested = await ctx.run.step("parse:ingest", () =>
      ingestFile({
        policy,
        filename: input.filename,
        mime: input.mime,
        buffer,
        ask: (args) => completeJson(ctx.complete, args),
      }),
    );
    if (ingested.dropped.length > 0) ctx.run.note("parse:dropped", ingested.dropped);

    const blocks = blocksFromParsedDocument({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      // Ids are per source file, so re-uploading the same file cannot collide.
      blocks: ingested.document.blocks.map((block, index) => ({
        ...block,
        id: `${input.source_file_id}-B${String(index + 1).padStart(3, "0")}`,
      })),
    });

    const block_count = await ctx.run.step("parse:persist", () =>
      persistParseBlocks({
        workspace_id: input.workspace_id,
        source_file_id: input.source_file_id,
        parser: ingested.effectiveParser,
        blocks,
      }),
    );

    return {
      output: {
        parser: ingested.effectiveParser,
        reason: policy.reason,
        block_count,
        dropped: ingested.dropped,
      },
      summary: `Parsed ${input.filename} → ${block_count} blocks (${ingested.effectiveParser})`,
    };
  },
});

export { resolveParsePolicy } from "./parse-policy";
export { ingestFile } from "./ingest-file";
