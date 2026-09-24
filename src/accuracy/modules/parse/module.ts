import { z } from "zod";
import {
  blocksFromParsedDocument,
  persistDroppedUnits,
  persistParseBlocksDetailed,
  recordLlmStakeholder,
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
  /** Re-parse of the same source: human blocks kept as they are. */
  kept_human_blocks: z.number().int().nonnegative().default(0),
  /** Re-parse: model blocks kept because a claim quotes them. */
  kept_cited_blocks: z.number().int().nonnegative().default(0),
  /** The model's stakeholder classification and why (null under the test stub). */
  stakeholder: z.object({ stakeholder_function: z.string(), rationale: z.string() }).nullable().default(null),
});

export const parseModule = agenticModule({
  id: "parse.llm-v1",
  call_kind: "parse",
  title: "LLM parse",
  summary:
    "Extract the file's text, then the chosen LLM decides blocks, kinds and headings. A re-parse keeps every human-made or human-edited block. LlamaParse is disabled.",
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

    const persisted = await ctx.run.step("parse:persist", () =>
      persistParseBlocksDetailed({
        workspace_id: input.workspace_id,
        source_file_id: input.source_file_id,
        parser: ingested.effectiveParser,
        blocks,
      }),
    );
    if (persisted.kept_human > 0 || persisted.kept_cited > 0) ctx.run.note("parse:kept", persisted);
    await persistDroppedUnits({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      units: ingested.dropped_units,
    });
    if (ingested.stakeholder) {
      // Stored beside, never over, a human override.
      await recordLlmStakeholder({
        workspace_id: input.workspace_id,
        source_file_id: input.source_file_id,
        stakeholder_function: ingested.stakeholder.stakeholder_function,
        rationale: ingested.stakeholder.rationale,
      });
    }

    const block_count = persisted.inserted;
    return {
      output: {
        parser: ingested.effectiveParser,
        reason: policy.reason,
        block_count,
        dropped: ingested.dropped,
        kept_human_blocks: persisted.kept_human,
        kept_cited_blocks: persisted.kept_cited,
        stakeholder: ingested.stakeholder,
      },
      summary: `Parsed ${input.filename} → ${block_count} blocks (${ingested.effectiveParser})${
        persisted.kept_human ? `, ${persisted.kept_human} human block(s) kept` : ""
      }`,
    };
  },
});

export { resolveParsePolicy } from "./parse-policy";
export { ingestFile } from "./ingest-file";
