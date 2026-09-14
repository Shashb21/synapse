import type { ParsedBlock, ParsedDocument, StakeholderFunction } from "@/lib/schema";
import { parseLocalDocument } from "@/lib/ingest/local-parse";
import { hashId } from "@/lib/text";

const UPLOAD_URL = "https://api.cloud.llamaindex.ai/api/v1/parsing/upload";

function guessFunction(filename: string): StakeholderFunction {
  const n = filename.toLowerCase();
  if (n.includes("payer") || n.includes("access")) return "market_access";
  if (n.includes("kol") || n.includes("medical")) return "medical_affairs";
  if (n.includes("enroll") || n.includes("clin")) return "clinops";
  if (n.includes("campaign") || n.includes("unbranded")) return "marketing";
  return "commercial";
}

function blocksFromMarkdown(md: string): ParsedBlock[] {
  const chunks = md
    .split(/\n{2,}/)
    .map((c) => c.replace(/^#+\s*/, "").replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
  return chunks.map((text, i) => ({
    id: `LLAMA-B${String(i + 1).padStart(2, "0")}`,
    location: {
      kind: "section" as const,
      ref: `block ${i + 1}`,
    },
    text,
    kind: i === 0 ? ("title" as const) : text.length > 160 ? ("paragraph" as const) : ("bullet" as const),
  }));
}

async function llamaParse(
  filename: string,
  buffer: Buffer,
  apiKey: string,
): Promise<ParsedDocument> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)]),
    filename,
  );
  const upload = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!upload.ok) {
    throw new Error(`LlamaParse upload failed (${upload.status})`);
  }
  const job = (await upload.json()) as { id?: string; job_id?: string };
  const jobId = job.id ?? job.job_id;
  if (!jobId) throw new Error("LlamaParse did not return a job id");

  let markdown = "";
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(
      `https://api.cloud.llamaindex.ai/api/v1/parsing/job/${jobId}/result/markdown`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (res.status === 202) continue;
    if (!res.ok) throw new Error(`LlamaParse poll failed (${res.status})`);
    const body = (await res.json()) as { markdown?: string };
    markdown = body.markdown ?? "";
    if (markdown) break;
  }
  if (!markdown) throw new Error("LlamaParse returned empty markdown");

  const blocks = blocksFromMarkdown(markdown).map((b) => ({
    ...b,
    id: hashId("BLK", `${filename}:${b.text.slice(0, 40)}`),
  }));
  return {
    id: hashId("DOC", `${filename}:llama:${buffer.length}`),
    filename,
    title: blocks[0]?.text ?? filename,
    stakeholder_function: guessFunction(filename),
    mime: "application/octet-stream",
    parser: "llamaparse",
    ingested_at: new Date().toISOString(),
    blocks,
    fullText: markdown,
  };
}

export async function ingestBuffer(args: {
  filename: string;
  buffer: Buffer;
  mime?: string;
}): Promise<{ document: ParsedDocument; parserUsed: "llamaparse" | "local" }> {
  const key = process.env.LLAMA_CLOUD_API_KEY;
  if (key) {
    try {
      const document = await llamaParse(args.filename, args.buffer, key);
      return { document, parserUsed: "llamaparse" };
    } catch {
      // Fall through to local OCR-free parsers.
    }
  }
  const document = await parseLocalDocument(args);
  return { document, parserUsed: "local" };
}
