import { z } from "zod";
import { hasLlamaCloudKey } from "@/lib/config";
import { isLlamaParseSource } from "@/lib/ingest/llama-gate";

export {
  LLAMA_PARSE_KEY_CODE,
  LLAMA_PARSE_KEY_REQUIRED,
  assertLlamaParseConfigured,
  isLlamaParseSource,
} from "@/lib/ingest/llama-gate";

export const parsePolicyInputSchema = z.object({
  filename: z.string(),
  mime: z.string(),
});

export type ParsePolicyInput = z.infer<typeof parsePolicyInputSchema>;

export type ParsePolicy = {
  parser: "llamaparse" | "local_structured" | "local_llm_assist";
  reason: string;
  /** True when PDF/PPTX is selected but LLAMA_CLOUD_API_KEY is missing. */
  missing_key?: boolean;
};

const LOCAL_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * Product lock: LlamaParse for PDF and PPTX.
 * With LLAMA_CLOUD_API_KEY, ingest uses cloud parse. Without it, policy still
 * selects llamaparse and ingest/upload are gated (no silent local fallback).
 */
export function resolveParsePolicy(input: ParsePolicyInput): ParsePolicy {
  const hasLlama = hasLlamaCloudKey();
  if (isLlamaParseSource(input.filename, input.mime)) {
    const kind =
      input.filename.toLowerCase().endsWith(".pdf") || input.mime === "application/pdf"
        ? "pdf"
        : "pptx";
    if (hasLlama) {
      return { parser: "llamaparse", reason: `${kind}_with_llama_key` };
    }
    return { parser: "llamaparse", reason: `${kind}_needs_llama`, missing_key: true };
  }
  const lower = input.filename.toLowerCase();
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
