import { hasLlamaCloudKey } from "@/lib/config";

export const LLAMA_PARSE_KEY_CODE = "llama_cloud_key_required";

export const LLAMA_PARSE_KEY_REQUIRED =
  "PDF and PPTX require LlamaParse. Set LLAMA_CLOUD_API_KEY in the server environment (never in the UI). DOCX, text, and spreadsheets still parse locally.";

const LLAMAPARSE_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);

/** PDF / PPT / PPTX — product lock is LlamaParse, not local OOXML. */
export function isLlamaParseSource(filename: string, mime = ""): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return true;
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt") || LLAMAPARSE_MIMES.has(mime)) {
    return true;
  }
  return false;
}

export function assertLlamaParseConfigured(): void {
  if (!hasLlamaCloudKey()) {
    throw new Error(LLAMA_PARSE_KEY_REQUIRED);
  }
}
