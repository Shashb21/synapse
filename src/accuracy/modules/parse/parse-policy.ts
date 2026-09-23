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

/**
 * Product lock: LlamaParse for PDF and PPTX.
 * With LLAMA_CLOUD_API_KEY, ingest uses cloud parse; without it, policy still selects
 * llamaparse and ingest falls back to local structured so uploads are not blocked.
 */
export function resolveParsePolicy(input: ParsePolicyInput): ParsePolicy {
  const lower = input.filename.toLowerCase();
  const hasLlama = Boolean(process.env.LLAMA_CLOUD_API_KEY?.trim());
  if (lower.endsWith(".pdf") || input.mime === "application/pdf") {
    return hasLlama
      ? { parser: "llamaparse", reason: "pdf_with_llama_key" }
      : { parser: "llamaparse", reason: "pdf_needs_llama" };
  }
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt") || LLAMAPARSE_MIMES.has(input.mime)) {
    return hasLlama
      ? { parser: "llamaparse", reason: "pptx_with_llama_key" }
      : { parser: "llamaparse", reason: "pptx_needs_llama" };
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
