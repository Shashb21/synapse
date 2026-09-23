import { z } from "zod";

export const parsePolicyInputSchema = z.object({
  filename: z.string(),
  mime: z.string(),
});

export type ParsePolicyInput = z.infer<typeof parsePolicyInputSchema>;

export type ParsePolicy = {
  parser: "llamaparse" | "local_structured" | "local_llm_assist";
  reason: string;
};

const LLAMAPARSE_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);

const LOCAL_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** Locked product policy: PDF/PPTX → LlamaParse; DOCX/text/xlsx → local (+ optional LLM assist inside parse module). */
export function resolveParsePolicy(input: ParsePolicyInput): ParsePolicy {
  const lower = input.filename.toLowerCase();
  if (lower.endsWith(".pdf") || lower.endsWith(".pptx") || lower.endsWith(".ppt")) {
    return { parser: "llamaparse", reason: "pdf_or_pptx" };
  }
  if (LLAMAPARSE_MIMES.has(input.mime)) {
    return { parser: "llamaparse", reason: "mime_pdf_ppt" };
  }
  if (
    lower.endsWith(".docx") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".xlsx") ||
    LOCAL_MIMES.has(input.mime)
  ) {
    return { parser: "local_structured", reason: "docx_text_or_sheet" };
  }
  return { parser: "local_llm_assist", reason: "fallback_messy_format" };
}
