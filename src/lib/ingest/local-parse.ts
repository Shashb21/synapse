import JSZip from "jszip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { ParsedBlock, ParsedDocument, StakeholderFunction } from "@/lib/schema";
import { hashId } from "@/lib/text";

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function xmlTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const t = decodeXml(m[1] ?? "").trim();
    if (t) out.push(t);
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function guessFunction(filename: string): StakeholderFunction {
  const n = filename.toLowerCase();
  if (n.includes("payer") || n.includes("access") || n.includes("amcp")) {
    return "market_access";
  }
  if (n.includes("kol") || n.includes("medical") || n.includes("medaff")) {
    return "medical_affairs";
  }
  if (n.includes("enroll") || n.includes("clin") || n.includes("protocol")) {
    return "clinops";
  }
  if (n.includes("campaign") || n.includes("unbranded") || n.includes("mkt")) {
    return "marketing";
  }
  if (n.includes("heor") || n.includes("icer")) return "heor";
  if (n.includes("label") || n.includes("regulat")) return "regulatory";
  return "commercial";
}

export function mimeForFilename(filename: string): string {
  const n = filename.toLowerCase();
  if (n.endsWith(".pptx")) return PPTX;
  if (n.endsWith(".docx")) return DOCX;
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return XLSX_MIME;
  if (n.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (n.endsWith(".doc")) return "application/msword";
  return "application/octet-stream";
}

async function parsePptx(buffer: Buffer): Promise<Omit<ParsedBlock, "id">[]> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/i)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)/i)?.[1] ?? 0);
      return na - nb;
    });

  const blocks: Omit<ParsedBlock, "id">[] = [];
  for (const file of slideFiles) {
    const xml = await zip.files[file]!.async("string");
    const n = Number(file.match(/slide(\d+)/i)?.[1] ?? 0);
    const texts = xmlTexts(xml, "a:t");
    const heading = texts[0];
    texts.forEach((text, i) => {
      blocks.push({
        location: { kind: "slide", ref: `Slide ${n}` },
        heading: i === 0 ? "Title" : heading,
        text,
        kind: i === 0 ? "title" : text.length > 180 ? "paragraph" : "bullet",
      });
    });
  }
  return blocks;
}

async function parseDocx(buffer: Buffer): Promise<Omit<ParsedBlock, "id">[]> {
  const result = await mammoth.extractRawText({ buffer });
  const paragraphs = result.value
    .split(/\n+/)
    .map((p: string) => p.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  return paragraphs.map((text: string, i: number) => ({
    location: { kind: "page" as const, ref: `p.${Math.floor(i / 4) + 1}` },
    heading: i === 0 ? "Title" : undefined,
    text,
    kind: i === 0 ? ("title" as const) : text.length > 140 ? ("paragraph" as const) : ("bullet" as const),
  }));
}

function parseXlsx(buffer: Buffer): Omit<ParsedBlock, "id">[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const blocks: Omit<ParsedBlock, "id">[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, {
      header: 1,
      raw: false,
    });
    const header = (rows[0] ?? []).map((c) => String(c ?? "").trim());
    rows.forEach((row, rIdx) => {
      if (rIdx === 0) return;
      const cells = (row ?? []).map((c) => String(c ?? "").trim());
      if (cells.every((c) => !c)) return;
      const heading = cells[0] || header[0] || name;
      const text = header.length
        ? header
            .map((h, i) => (cells[i] ? `${h}: ${cells[i]}` : null))
            .filter(Boolean)
            .join(". ")
        : cells.filter(Boolean).join(". ");
      if (!text) return;
      blocks.push({
        location: { kind: "sheet", ref: `${name}!R${rIdx + 1}` },
        heading: String(heading),
        text,
        kind: "cell",
      });
    });
  }
  return blocks;
}

export async function parseLocalDocument(args: {
  filename: string;
  buffer: Buffer;
  mime?: string;
}): Promise<ParsedDocument> {
  const mime = args.mime || mimeForFilename(args.filename);
  const lower = args.filename.toLowerCase();
  let blocks: Omit<ParsedBlock, "id">[] = [];
  if (lower.endsWith(".pptx") || mime === PPTX) {
    blocks = await parsePptx(args.buffer);
  } else if (lower.endsWith(".docx") || mime === DOCX) {
    blocks = await parseDocx(args.buffer);
  } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || mime === XLSX_MIME) {
    blocks = parseXlsx(args.buffer);
  } else {
    throw new Error(
      `Unsupported file type: ${args.filename}. Upload PPTX, DOCX, or XLSX.`,
    );
  }

  const id = hashId("DOC", `${args.filename}:${args.buffer.length}`);
  const numbered = blocks.map((b, i) => ({
    ...b,
    id: `${id}-B${String(i + 1).padStart(2, "0")}`,
  }));
  return {
    id,
    filename: args.filename,
    title: numbered[0]?.text ?? args.filename,
    stakeholder_function: guessFunction(args.filename),
    mime,
    parser: "local",
    ingested_at: new Date().toISOString(),
    blocks: numbered,
    fullText: numbered.map((b) => `[${b.location.ref}] ${b.text}`).join("\n"),
  };
}
