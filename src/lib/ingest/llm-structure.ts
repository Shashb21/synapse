import { extractText, getDocumentProxy } from "unpdf";
import { completeAll } from "@/modules/kernel/llm";
import { STAKEHOLDER_FUNCTIONS, type ParsedBlock, type ParsedDocument, type StakeholderFunction } from "@/lib/schema";
import { hashId } from "@/lib/text";
import { mimeForFilename, parseLocalDocument } from "./local-parse";

/**
 * Parsing is split in two. Pulling raw text out of a file (slides, pages,
 * paragraphs, sheet rows) is mechanical. Deciding how that text is structured —
 * which lines are headings, what each block is, what is noise — is a judgement,
 * and the chosen LLM makes it. LlamaParse is not used.
 */

export type RawUnit = { location: ParsedBlock["location"]; text: string };

type Ask = (args: { system: string; user: string; purpose: string }) => Promise<unknown>;

const BLOCK_KINDS = [
  "title",
  "heading",
  "bullet",
  "paragraph",
  "table_cell",
  "cell",
  "chart",
  "figure",
] as const satisfies readonly ParsedBlock["kind"][];

/** Characters of source text per prompt; keeps each call well inside context. */
const CHUNK_CHARS = 12_000;

const STRUCTURE_SYSTEM = `You structure text extracted from a pharma evidence-planning document (slides, a report, interview notes, a spreadsheet) into blocks.

You get numbered units of raw extracted text, each with its location (slide, page or sheet). For every unit, return the blocks it contains, in order:
- text: a verbatim span of the unit's text. Copy it exactly; never paraphrase, summarize, translate or fix it. A unit may split into several blocks, or be one block.
- kind: one of ${BLOCK_KINDS.join(", ")}.
- heading: the section heading this block sits under, copied verbatim from the document, or null when there is none.

A unit that is only noise (page number, footer, slide chrome, legal boilerplate) may return no blocks; then give a one-line "dropped_reason".

Return every unit you are given. Return JSON only: {"units":[{"unit":"u1","blocks":[{"text":"","kind":"paragraph","heading":null}],"dropped_reason":null}]}`;

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Mechanical extraction: raw text with its location, no structure decided. */
export async function extractRawUnits(args: {
  filename: string;
  buffer: Buffer;
  mime?: string;
}): Promise<RawUnit[]> {
  const lower = args.filename.toLowerCase();
  const mime = args.mime || mimeForFilename(args.filename);
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(args.buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const units = pages.flatMap((page, index) =>
      page
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => ({ location: { kind: "page" as const, ref: `p.${index + 1}` }, text: chunk })),
    );
    if (units.length === 0) {
      throw new Error(`${args.filename} has no extractable text (a scanned PDF needs OCR, which is not available).`);
    }
    return units;
  }
  // The local extractors already read PPTX, DOCX, XLSX and text; only their
  // text and location are kept — the headings and kinds they guessed are not.
  const local = await parseLocalDocument(args);
  return local.blocks.map((block) => ({ location: block.location, text: block.text }));
}

/** A unit the model judged to be noise, kept verbatim so a human can restore it. */
export type DroppedUnit = { location: string; reason: string; text: string };

type UnitAnswer = { blocks: Omit<ParsedBlock, "id" | "location">[]; dropped_reason: string | null };

function readAnswer(unit: RawUnit, row: unknown): UnitAnswer | undefined {
  if (!row || typeof row !== "object") return undefined;
  const { blocks, dropped_reason } = row as { blocks?: unknown; dropped_reason?: unknown };
  if (!Array.isArray(blocks)) return undefined;
  const source = squash(unit.text);
  const out: UnitAnswer["blocks"] = [];
  for (const block of blocks) {
    const { text, kind, heading } = (block ?? {}) as { text?: unknown; kind?: unknown; heading?: unknown };
    if (typeof text !== "string" || !squash(text)) return undefined;
    // Verbatim is checked, not trusted: a block must be a span of its unit.
    if (!source.includes(squash(text))) return undefined;
    if (typeof kind !== "string" || !(BLOCK_KINDS as readonly string[]).includes(kind)) return undefined;
    if (heading !== null && heading !== undefined && typeof heading !== "string") return undefined;
    out.push({
      text: text.trim(),
      kind: kind as ParsedBlock["kind"],
      heading: typeof heading === "string" && heading.trim() ? heading.trim() : undefined,
    });
  }
  const reason = typeof dropped_reason === "string" ? dropped_reason.trim() : "";
  // An empty unit must say why it was dropped.
  if (out.length === 0 && !reason) return undefined;
  return { blocks: out, dropped_reason: reason || null };
}

function chunk(units: { id: string; unit: RawUnit }[]): { id: string; unit: RawUnit }[][] {
  const chunks: { id: string; unit: RawUnit }[][] = [];
  let current: { id: string; unit: RawUnit }[] = [];
  let size = 0;
  for (const entry of units) {
    if (current.length > 0 && size + entry.unit.text.length > CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entry.unit.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The chosen LLM decides every block's boundaries, kind and heading. */
export async function structureWithLlm(args: {
  filename: string;
  units: RawUnit[];
  ask: Ask;
}): Promise<{
  blocks: Omit<ParsedBlock, "id">[];
  dropped: { location: string; reason: string }[];
  /** The same dropped units with their raw text, so a human can restore one as a block. */
  dropped_units: DroppedUnit[];
}> {
  const entries = args.units.map((unit, index) => ({ id: `u${index + 1}`, unit }));
  const answers = new Map<string, UnitAnswer>();
  for (const [index, group] of chunk(entries).entries()) {
    const byId = new Map(group.map((entry) => [entry.id, entry.unit]));
    const done = await completeAll({
      ids: group.map((entry) => entry.id),
      what: "parse",
      describe: (id) => `${byId.get(id)!.location.ref} (${id})`,
      remedy: "upload the file again or switch the parse route in /admin/control.",
      ask: async (missing, attempt) => {
        const payload = (await args.ask({
          system: STRUCTURE_SYSTEM,
          user: JSON.stringify({
            filename: args.filename,
            note:
              attempt > 1
                ? "An earlier answer left these units out, or returned text that is not a verbatim span of the unit, or an unknown kind. Answer each again."
                : undefined,
            units: missing.map((id) => ({ unit: id, location: byId.get(id)!.location.ref, text: byId.get(id)!.text })),
          }),
          purpose: `parse-structure:${index + 1}`,
        })) as { units?: { unit?: string }[] } | null;
        const map = new Map<string, UnitAnswer>();
        for (const row of payload?.units ?? []) {
          const unit = row?.unit ? byId.get(row.unit) : undefined;
          if (!unit || !missing.includes(row.unit!)) continue;
          const answer = readAnswer(unit, row);
          if (answer) map.set(row.unit!, answer);
        }
        return map;
      },
    });
    for (const [id, answer] of done) answers.set(id, answer);
  }
  const blocks: Omit<ParsedBlock, "id">[] = [];
  const dropped: { location: string; reason: string }[] = [];
  const dropped_units: DroppedUnit[] = [];
  for (const entry of entries) {
    const answer = answers.get(entry.id)!;
    if (answer.dropped_reason && answer.blocks.length === 0) {
      dropped.push({ location: entry.unit.location.ref, reason: answer.dropped_reason });
      dropped_units.push({ location: entry.unit.location.ref, reason: answer.dropped_reason, text: entry.unit.text });
    }
    for (const block of answer.blocks) blocks.push({ ...block, location: entry.unit.location });
  }
  if (blocks.length === 0) throw new Error(`The model found no content blocks in ${args.filename}.`);
  return { blocks, dropped, dropped_units };
}

const STAKEHOLDER_SYSTEM = `You read the opening of a pharma evidence-planning document and say which stakeholder function it comes from or speaks for.

Pick exactly one of: ${STAKEHOLDER_FUNCTIONS.join(", ")}. Give a one-sentence rationale.

Return JSON only: {"stakeholder_function":"","rationale":""}`;

/** The model, not the filename, says whose document this is. */
async function classifyStakeholder(args: {
  filename: string;
  blocks: Omit<ParsedBlock, "id">[];
  ask: Ask;
}): Promise<{ stakeholder_function: StakeholderFunction; rationale: string }> {
  const opening = args.blocks.slice(0, 40).map((block) => ({ kind: block.kind, text: block.text }));
  const done = await completeAll({
    ids: ["document"],
    what: "stakeholder classification",
    describe: () => args.filename,
    remedy: "upload the file again or switch the parse route in /admin/control.",
    ask: async (_missing, attempt) => {
      const payload = (await args.ask({
        system: STAKEHOLDER_SYSTEM,
        user: JSON.stringify({
          filename: args.filename,
          note: attempt > 1 ? "The earlier answer was not one of the listed functions." : undefined,
          opening,
        }),
        purpose: "parse-stakeholder",
      })) as { stakeholder_function?: unknown; rationale?: unknown } | null;
      const value = payload?.stakeholder_function;
      const rationale = typeof payload?.rationale === "string" ? payload.rationale.trim() : "";
      const map = new Map<string, { stakeholder_function: StakeholderFunction; rationale: string }>();
      if (typeof value === "string" && (STAKEHOLDER_FUNCTIONS as readonly string[]).includes(value) && rationale) {
        map.set("document", { stakeholder_function: value as StakeholderFunction, rationale });
      }
      return map;
    },
  });
  return done.get("document")!;
}

/** Extract, then have the LLM structure: the one parse path for every file type. */
export async function parseWithLlm(args: {
  filename: string;
  buffer: Buffer;
  mime?: string;
  ask: Ask;
}): Promise<{
  document: ParsedDocument;
  dropped: { location: string; reason: string }[];
  dropped_units: DroppedUnit[];
  stakeholder_rationale: string;
}> {
  const mime = args.mime || mimeForFilename(args.filename);
  const units = await extractRawUnits({ filename: args.filename, buffer: args.buffer, mime });
  const { blocks, dropped, dropped_units } = await structureWithLlm({ filename: args.filename, units, ask: args.ask });
  const stakeholder = await classifyStakeholder({ filename: args.filename, blocks, ask: args.ask });
  const id = hashId("DOC", `${args.filename}:${args.buffer.length}`);
  const numbered = blocks.map((block, index) => ({ ...block, id: `${id}-B${String(index + 1).padStart(2, "0")}` }));
  return {
    document: {
      id,
      filename: args.filename,
      title: numbered.find((block) => block.kind === "title")?.text ?? args.filename,
      stakeholder_function: stakeholder.stakeholder_function,
      mime,
      parser: "llm",
      ingested_at: new Date().toISOString(),
      blocks: numbered,
      fullText: numbered.map((block) => `[${block.location.ref}] ${block.text}`).join("\n"),
    },
    dropped,
    dropped_units,
    stakeholder_rationale: stakeholder.rationale,
  };
}
