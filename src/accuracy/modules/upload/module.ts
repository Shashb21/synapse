import { z } from "zod";
import { mechanicalModule } from "../_factory";

const inputSchema = z.object({
  workspace_id: z.string(),
  org_id: z.string(),
  filename: z.string(),
  mime: z.string(),
  checksum: z.string(),
  doc_role: z.string().optional(),
});

const outputSchema = z.object({
  source_file_id: z.string(),
});

export const uploadModule = mechanicalModule({
  id: "upload.local-v1",
  call_kind: "upload",
  title: "Upload",
  summary: "Register a source file for the workspace IEGP.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    const id = `src-${input.checksum.slice(0, 12)}`;
    ctx.run.note("upload:registered", { id, filename: input.filename });
    return {
      output: { source_file_id: id },
      summary: `Registered ${input.filename}`,
    };
  },
});
