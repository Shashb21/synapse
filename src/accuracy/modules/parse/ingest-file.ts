import { parseLocalDocument } from "@/lib/ingest/local-parse";
import { extractRawUnits, parseWithLlm, type DroppedUnit } from "@/lib/ingest/llm-structure";
import { isTestStub } from "@/modules/kernel/llm";
import { hashId } from "@/lib/text";
import type { ParsedDocument } from "@/lib/schema";
import type { ParsePolicy } from "./parse-policy";

export type IngestFileResult = {
  document: ParsedDocument;
  effectiveParser: ParsePolicy["parser"];
  dropped: { location: string; reason: string }[];
  /** Dropped noise units with their raw text (a human can restore one). */
  dropped_units: DroppedUnit[];
  /** The model's stakeholder classification and why; null under the test stub. */
  stakeholder: { stakeholder_function: string; rationale: string } | null;
};

/** Test stub only: the local extractors' blocks stand in for the model's structure. */
async function stubDocument(filename: string, buffer: Buffer, mime: string): Promise<ParsedDocument> {
  if (!filename.toLowerCase().endsWith(".pdf")) return parseLocalDocument({ filename, buffer, mime });
  const units = await extractRawUnits({ filename, buffer, mime });
  const blocks = units.map((unit, index) => ({
    id: `STUB-B${String(index + 1).padStart(2, "0")}`,
    location: unit.location,
    text: unit.text,
    kind: "paragraph" as const,
  }));
  return {
    id: hashId("DOC", `${filename}:${buffer.length}`),
    filename,
    title: filename,
    stakeholder_function: "medical_affairs",
    mime,
    parser: "local",
    ingested_at: new Date().toISOString(),
    blocks,
    fullText: blocks.map((block) => `[${block.location.ref}] ${block.text}`).join("\n"),
  };
}

/** Extract the file's text, then have the parse route's LLM structure it. */
export async function ingestFile(args: {
  policy: ParsePolicy;
  filename: string;
  mime: string;
  buffer: Buffer;
  ask: (args: { system: string; user: string; purpose: string }) => Promise<unknown>;
}): Promise<IngestFileResult> {
  const { filename, mime, buffer } = args;
  if (isTestStub()) {
    return {
      document: await stubDocument(filename, buffer, mime),
      effectiveParser: "local_structured",
      dropped: [],
      dropped_units: [],
      stakeholder: null,
    };
  }
  const { document, dropped, dropped_units, stakeholder_rationale } = await parseWithLlm({
    filename,
    buffer,
    mime,
    ask: args.ask,
  });
  return {
    document,
    effectiveParser: "llm",
    dropped,
    dropped_units,
    stakeholder: { stakeholder_function: document.stakeholder_function, rationale: stakeholder_rationale },
  };
}
