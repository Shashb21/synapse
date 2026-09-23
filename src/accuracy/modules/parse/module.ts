import { z } from "zod";
import { mechanicalModule } from "../_factory";
import { resolveParsePolicy } from "./parse-policy";

const inputSchema = z.object({
  workspace_id: z.string(),
  source_file_id: z.string(),
  filename: z.string(),
  mime: z.string(),
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
    return {
      output: {
        parser: policy.parser,
        reason: policy.reason,
        block_count: 0,
      },
      summary: `Parse policy ${policy.parser} (${policy.reason})`,
    };
  },
});

export { resolveParsePolicy } from "./parse-policy";
