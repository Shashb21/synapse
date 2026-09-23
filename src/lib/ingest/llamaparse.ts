import {
  hasLlamaCloudKey,
  llamaParseTier,
} from "@/lib/config";
import {
  assertLlamaParseConfigured,
  isLlamaParseSource,
} from "@/lib/ingest/llama-gate";
import {
  blocksFromLlamaResult,
  LLAMA_CHART_PROMPT,
  type LlamaParseResult,
} from "@/lib/ingest/llama-blocks";
import { mimeForFilename, parseLocalDocument } from "@/lib/ingest/local-parse";
import type { ParsedDocument, StakeholderFunction } from "@/lib/schema";
import { hashId } from "@/lib/text";

const BASE = "https://api.cloud.llamaindex.ai";

export type IngestWarning = {
  parserUsed: "llamaparse" | "local";
  llamaError?: string;
};

function guessFunction(filename: string): StakeholderFunction {
  const n = filename.toLowerCase();
  if (n.includes("payer") || n.includes("access")) return "market_access";
  if (n.includes("kol") || n.includes("medical")) return "medical_affairs";
  if (n.includes("enroll") || n.includes("clin")) return "clinops";
  if (n.includes("campaign") || n.includes("unbranded")) return "marketing";
  return "commercial";
}

async function llamaParseV2(
  filename: string,
  buffer: Buffer,
  apiKey: string,
): Promise<ParsedDocument> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)]), filename);
  form.append(
    "configuration",
    JSON.stringify({
      tier: llamaParseTier(),
      version: "latest",
      processing_options: {
        specialized_chart_parsing: "agentic",
        aggressive_table_extraction: true,
      },
      agentic_options: {
        custom_prompt: LLAMA_CHART_PROMPT,
      },
    }),
  );

  const upload = await fetch(`${BASE}/api/v2/parse/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const uploaded = (await upload.json()) as {
    id?: string;
    status?: string;
    detail?: unknown;
  };
  if (!upload.ok || !uploaded.id) {
    throw new Error(
      `LlamaParse upload failed (${upload.status}): ${JSON.stringify(uploaded.detail ?? uploaded)}`,
    );
  }

  let result: LlamaParseResult & {
    job?: { id?: string; status?: string; error_message?: string | null };
  } = {};
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(
      `${BASE}/api/v2/parse/${uploaded.id}?expand=markdown_full,markdown,items`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    result = (await res.json()) as typeof result;
    const status = result.job?.status ?? uploaded.status;
    if (status === "FAILED" || status === "CANCELLED") {
      throw new Error(result.job?.error_message ?? `LlamaParse ${status}`);
    }
    if (status === "COMPLETED" || result.markdown_full || result.markdown) {
      break;
    }
  }

  const blocksRaw = blocksFromLlamaResult(result);
  if (blocksRaw.length === 0) {
    throw new Error("LlamaParse returned no extractable text or chart data");
  }
  const id = hashId("DOC", `${filename}:llama:${buffer.length}`);
  const blocks = blocksRaw.map((b, i) => ({
    ...b,
    id: `${id}-B${String(i + 1).padStart(2, "0")}`,
  }));
  return {
    id,
    filename,
    title: blocks[0]?.text ?? filename,
    stakeholder_function: guessFunction(filename),
    mime: mimeForFilename(filename),
    parser: "llamaparse",
    ingested_at: new Date().toISOString(),
    blocks,
    fullText: blocks.map((b) => `[${b.location.ref}] ${b.text}`).join("\n"),
  };
}

export async function ingestBuffer(args: {
  filename: string;
  buffer: Buffer;
  mime?: string;
}): Promise<{
  document: ParsedDocument;
  parserUsed: "llamaparse" | "local";
  llamaError?: string;
}> {
  const key = process.env.LLAMA_CLOUD_API_KEY?.trim();
  if (isLlamaParseSource(args.filename, args.mime)) {
    assertLlamaParseConfigured();
  }
  if (hasLlamaCloudKey() && key) {
    try {
      const document = await llamaParseV2(args.filename, args.buffer, key);
      return { document, parserUsed: "llamaparse" };
    } catch (error) {
      const llamaError = error instanceof Error ? error.message : "LlamaParse failed";
      const document = await parseLocalDocument(args);
      return { document, parserUsed: "local", llamaError };
    }
  }
  const document = await parseLocalDocument(args);
  return { document, parserUsed: "local" };
}
