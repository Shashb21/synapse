import { ingestBuffer } from "@/lib/ingest/llamaparse";
import { parseLocalDocument } from "@/lib/ingest/local-parse";
import type { ParsedDocument } from "@/lib/schema";
import type { ParsePolicy } from "./parse-policy";

export type IngestFileResult = {
  document: ParsedDocument;
  effectiveParser: ParsePolicy["parser"];
  llamaError?: string;
};

/** Route buffer ingest per locked parse policy (LlamaParse vs local structured). */
export async function ingestFile(args: {
  policy: ParsePolicy;
  filename: string;
  mime: string;
  buffer: Buffer;
}): Promise<IngestFileResult> {
  const { policy, filename, mime, buffer } = args;

  if (policy.parser === "llamaparse") {
    const { document, parserUsed, llamaError } = await ingestBuffer({
      filename,
      buffer,
      mime,
    });
    const effectiveParser =
      parserUsed === "llamaparse" ? "llamaparse" : "local_structured";
    return { document, effectiveParser, llamaError };
  }

  if (policy.parser === "local_structured") {
    const document = await parseLocalDocument({ filename, buffer, mime });
    return { document, effectiveParser: "local_structured" };
  }

  try {
    const document = await parseLocalDocument({ filename, buffer, mime });
    return { document, effectiveParser: "local_structured" };
  } catch (localError) {
    const { document, parserUsed, llamaError } = await ingestBuffer({
      filename,
      buffer,
      mime,
    });
    if (parserUsed === "local" && llamaError) {
      const reason =
        localError instanceof Error ? localError.message : String(localError);
      throw new Error(
        `local_llm_assist failed (${reason}); Llama fallback: ${llamaError}`,
      );
    }
    return { document, effectiveParser: "local_llm_assist", llamaError };
  }
}
