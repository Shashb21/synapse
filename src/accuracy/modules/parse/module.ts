import { z } from "zod";
import {
  blocksFromParsedDocument,
  persistParseBlocks,
} from "@/accuracy/store/parse-store";
import { mechanicalModule } from "../_factory";
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
  parser: z.enum(["llamaparse", "local_structured", "local_llm_assist"]),
  reason: z.string(),
  block_count: z.number().int().nonnegative(),
});

export const parseModule = mechanicalModule({
  id: "parse.router-v1",
  call_kind: "parse",
  title: "Parse router",
  summary: "Select parser and emit parse-store blocks (LlamaParse vs local).",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
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
      }),
    );
    if (ingested.llamaError) {
      ctx.run.note("parse:llama_fallback", { error: ingested.llamaError });
    }

    const blocks = blocksFromParsedDocument({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      blocks: ingested.document.blocks,
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
      },
      summary: `Parsed ${input.filename} → ${block_count} blocks (${ingested.effectiveParser})`,
    };
  },
});

export { resolveParsePolicy } from "./parse-policy";
export { ingestFile } from "./ingest-file";
