/** Read-only workspace snapshots and isolated source/reference preparation. */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";
import {
  extractRawUnits,
  parseLimitError,
  parseWithLlm,
} from "@/lib/ingest/llm-structure";
import {
  MAX_UPLOAD_BYTES,
  TOO_LARGE,
  uploadKindOf,
} from "@/lib/ingest/upload-formats";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";
import { aiSections } from "@/modules/kernel/ai-switch";
import { isTestStub } from "@/modules/kernel/llm";
import { completionFor, resolveRoute } from "@/modules/kernel/routing";
import { NoRouteError } from "@/modules/llm/provider";
import {
  DevelopmentError,
  structuredReferenceSchema,
  type DevelopmentDocument,
  type DevelopmentSection,
  type Experiment,
  type ParserIdentity,
} from "./schema";
/** Content identity independent of filename and source workspace identifiers. */
export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/**
 * Serialize parsed content using normalized JSON and recursively sorted object keys.
 *
 * Parameters
 * ----------
 * value : unknown
 *     Parsed content. JSON.stringify semantics remove undefined object properties
 *     and convert unsupported array entries and non-finite numbers to null.
 *
 * Returns
 * -------
 * string
 *     Compact JSON with keys sorted by JavaScript's UTF-16 code-unit order,
 *     original array order, and ordinary JSON string/number encoding.
 *
 * Raises
 * ------
 * TypeError
 *     If the value has no JSON representation, contains BigInt, or is circular.
 */
export function canonicalParsedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new TypeError("Parsed content must have a JSON representation.");
  const normalized: JsonValue = JSON.parse(json);
  return serializeJson(normalized);
}
/** Serialize an already-normalized JSON value without insertion-order dependence. */
function serializeJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(serializeJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
/** Validate canonical base64 and bound decoded bytes before parsing. */
export function uploadBytes(content: string): Buffer {
  if (content.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4)
    throw new DevelopmentError(413, "too_large", TOO_LARGE);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      content,
    )
  )
    throw new DevelopmentError(
      400,
      "invalid_upload",
      "Upload valid base64 file contents.",
    );
  const buffer = Buffer.from(content, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES)
    throw new DevelopmentError(413, "too_large", TOO_LARGE);
  if (!buffer.length)
    throw new DevelopmentError(
      422,
      "empty_document",
      "That document is empty. Choose a file containing readable text.",
    );
  return buffer;
}
/** List only the permanently bound workspace's source files. */
export async function discoverSources(experiment: Experiment): Promise<
  {
    id: string;
    filename: string;
    status: string;
  }[]
> {
  if (!experiment.source_workspace_id) return [];
  return withAdminWorkspace(
    async () =>
      (await db().execute(
        sql`select id,filename,status from source_files where workspace_id=${experiment.source_workspace_id} order by uploaded_at desc`,
      )) as unknown as {
        id: string;
        filename: string;
        status: string;
      }[],
    experiment.source_workspace_id,
  );
}
/** Make an immutable snapshot without modifying customer ingestion or parsed artifacts. */
export async function snapshotWorkspaceSource(
  experiment: Experiment,
  fileId: string,
  actor: string,
): Promise<{
  document: DevelopmentDocument;
  content_base64: string;
}> {
  if (!experiment.source_workspace_id)
    throw new DevelopmentError(
      400,
      "workspace_required",
      "This private-only experiment has no workspace sources. Upload a private source instead.",
    );
  return withAdminWorkspace(async () => {
    const files = await db().execute(
      sql`select * from source_files where id=${fileId} and workspace_id=${experiment.source_workspace_id}`,
    );
    const file = files[0];
    if (!file)
      throw new DevelopmentError(
        404,
        "not_found",
        "That source does not belong to the experiment's source workspace.",
      );
    const parses = await db().execute(
      sql`select * from parsed_documents where file_id=${fileId} order by parsed_at desc limit 1`,
    );
    const parsed = parses[0];
    if (
      !parsed ||
      !Array.isArray(parsed.blocks) ||
      !parsed.blocks.some(
        (block) => block && typeof block.text === "string" && block.text.trim(),
      )
    )
      throw new DevelopmentError(
        422,
        "source_not_parsed",
        "Parse this source in its workspace first, then import it again. Development requires an existing nonempty parsed snapshot.",
      );
    if (typeof file.content_base64 !== "string" || !file.content_base64)
      throw new DevelopmentError(
        422,
        "original_unavailable",
        "This source has no retained original bytes. Upload the original file privately instead.",
      );
    const buffer = uploadBytes(file.content_base64);
    const document = makeDocument(experiment, actor, {
      filename: String(file.filename),
      mime: String(file.mime),
      buffer,
      parsed: { blocks: parsed.blocks, quality: parsed.quality },
      parser: {
        name: String(parsed.parser),
        version: String(parsed.parser_version),
        model: null,
        prompt: null,
      },
    });
    return {
      document: {
        ...document,
        origin: "workspace",
        source_workspace_id: experiment.source_workspace_id,
        source_file_id: fileId,
        original_owner: String(file.uploaded_by),
        original_created_at: String(file.uploaded_at),
        parsed_at: String(parsed.parsed_at),
      },
      content_base64: buffer.toString("base64"),
    };
  }, experiment.source_workspace_id);
}
type Prepared = {
  filename: string;
  mime: string;
  buffer: Buffer;
  parsed: unknown;
  parser: ParserIdentity;
};
function makeDocument(
  experiment: Experiment,
  actor: string,
  input: Prepared,
): DevelopmentDocument {
  return {
    id: randomUUID(),
    experiment_id: experiment.id,
    role: "source",
    origin: "private",
    filename: input.filename,
    mime: input.mime,
    bytes: input.buffer.length,
    sha256: sha256(input.buffer),
    parsed_sha256: sha256(canonicalParsedJson(input.parsed)),
    parsed: input.parsed,
    parser: input.parser,
    created_by: actor,
    created_at: new Date().toISOString(),
    original_owner: actor,
    original_created_at: new Date().toISOString(),
    parsed_at: new Date().toISOString(),
    source_workspace_id: null,
    source_file_id: null,
    section: null,
    source_document_ids: [],
    review_status: "not_applicable",
    compatibility: "compatible",
  };
}
async function parserCompletion() {
  if (!(await aiSections()).ingestion)
    throw new DevelopmentError(
      409,
      "ai_disabled",
      "AI ingestion is turned off. Enable ingestion in /admin/control before parsing a private document or PDF reference.",
    );
  const run_id = `development-parse-${randomUUID()}`;
  if (isTestStub())
    return {
      ask: async () => ({}),
      parser: {
        name: "llm-test-stub",
        version: "1",
        model: "test-stub",
        prompt: "development-document-preparation-v1",
        run_id,
        provider_id: "test-stub",
      },
    };
  try {
    const route = await resolveRoute("S1");
    const ask = completionFor(route, {
      id: run_id,
      step: async (_name, fn) => await fn(),
      note: () => undefined,
      steps: () => [],
    });
    return {
      ask,
      parser: {
        name: "llm",
        version: "2.0.0",
        model: route.model,
        prompt: "s1-parse-structure+stakeholder-v2/development-reference-v1",
        run_id,
        provider_id: route.provider_id,
      },
    };
  } catch (error) {
    if (error instanceof NoRouteError)
      throw new DevelopmentError(
        409,
        "parser_unavailable",
        "Document parsing needs a configured provider. Set the S1 parsing route and API key in /admin/control, then retry.",
      );
    throw error;
  }
}
async function parseFile(
  filename: string,
  buffer: Buffer,
  mime: string,
  completion: Awaited<ReturnType<typeof parserCompletion>>,
) {
  let units;
  try {
    units = await extractRawUnits({ filename, buffer, mime });
  } catch {
    throw new DevelopmentError(
      422,
      "parse_failed",
      "Could not read this document. Use a text-based PDF (scans require OCR), a valid supported file, or a smaller text file and retry.",
    );
  }
  if (!units.length || !units.some((unit) => unit.text.trim()))
    throw new DevelopmentError(
      422,
      "empty_document",
      "This document contains no readable text. Upload a text-based file.",
    );
  // Bound mechanical extraction here. parseWithLlm enforces the exact chunk/call
  // budget before dispatch; the test-only local representation makes no calls.
  const error = parseLimitError(filename, units.length, 0);
  if (error) throw new DevelopmentError(422, "parse_limit", error);
  if (isTestStub())
    return {
      blocks: units.map((unit, index) => ({
        id: `test-block-${index + 1}`,
        text: unit.text,
        kind: "paragraph",
        location: unit.location,
      })),
    };
  try {
    return (await parseWithLlm({ filename, buffer, mime, ask: completion.ask }))
      .document;
  } catch {
    throw new DevelopmentError(
      422,
      "parse_failed",
      "The parser could not produce valid document blocks. Try a smaller text-based document or check the S1 parsing route in /admin/control.",
    );
  }
}
/** Parse a private source without publishing to any customer workspace. */
export async function prepareSource(
  experiment: Experiment,
  actor: string,
  filename: string,
  content: string,
) {
  const buffer = uploadBytes(content),
    kind = uploadKindOf(filename);
  if (kind.kind === "refused")
    throw new DevelopmentError(400, "unsupported_format", kind.reason);
  const mime = kind.kind === "text" ? "text/plain" : kind.mime;
  const completion = await parserCompletion();
  const parsed = await parseFile(filename, buffer, mime, completion);
  return {
    document: makeDocument(experiment, actor, {
      filename,
      mime,
      buffer,
      parsed,
      parser: completion.parser,
    }),
    content_base64: buffer.toString("base64"),
  };
}
/** Validate source associations before any reference parsing or model call. */
export function validateAssociations(
  experiment: Experiment,
  sourceIds: string[],
): void {
  const sources = new Set(
    experiment.documents
      .filter((document) => document.role === "source")
      .map((document) => document.id),
  );
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((id) => !sources.has(id))
  )
    throw new DevelopmentError(
      400,
      "invalid_association",
      "Associate the reference only with unique source snapshots in this experiment.",
    );
}
/** Prepare optional evaluator-only references; AI-derived answers remain provisional. */
export async function prepareReference(
  experiment: Experiment,
  actor: string,
  input: {
    filename: string;
    content_base64: string;
    format: "pdf" | "structured";
    section: DevelopmentSection;
    source_document_ids: string[];
  },
) {
  validateAssociations(experiment, input.source_document_ids);
  const buffer = uploadBytes(input.content_base64);
  let parsed: unknown,
    parser: ParserIdentity,
    compatibility: "compatible" | "incompatible" = "compatible";
  if (input.format === "structured") {
    if (!input.filename.toLowerCase().endsWith(".json"))
      throw new DevelopmentError(
        400,
        "unsupported_format",
        "Choose a .json structured reference document.",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new DevelopmentError(
        400,
        "invalid_reference",
        "This reference is not valid JSON. Use the documented version 1 structured reference format.",
      );
    }
    const result = structuredReferenceSchema.safeParse(raw);
    if (!result.success)
      throw new DevelopmentError(
        400,
        "invalid_reference",
        "This reference does not match the strict version 1 format. Check the section, expected answer records and source associations in docs/development/experiment-contract.md.",
      );
    if (
      result.data.section !== input.section ||
      JSON.stringify([...result.data.source_document_ids].sort()) !==
        JSON.stringify([...input.source_document_ids].sort())
    )
      throw new DevelopmentError(
        400,
        "invalid_association",
        "The reference section and source IDs must match the upload's associations.",
      );
    parsed = result.data;
    parser = {
      name: "development-structured-reference",
      version: "1",
      model: null,
      prompt: null,
    };
  } else {
    if (
      !input.filename.toLowerCase().endsWith(".pdf") ||
      !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
    )
      throw new DevelopmentError(
        400,
        "unsupported_format",
        "Choose a valid PDF reference, or upload a structured .json reference separately.",
      );
    const completion = await parserCompletion();
    const document = await parseFile(
      input.filename,
      buffer,
      "application/pdf",
      completion,
    );
    let expected: unknown;
    try {
      expected = await completion.ask({
        system: `Extract evaluator-only expected answers from this expert reference. Return strict JSON version 1 with section, source_document_ids and expected_answers. Every answer needs id and source_document_id. For gap_extraction use statement,quote; tactic_extraction title,description,quote; matching_coverage gap_id,tactic_id,relevance (relevant|irrelevant),coverage (addressed|partial|open),rationale; partial_splitting parent_gap_id,addressed_statement,residual_statement,tactic_ids. Do not invent unsupported answers.`,
        user: JSON.stringify({
          section: input.section,
          source_document_ids: input.source_document_ids,
          document,
        }),
        purpose: "development-reference-expectations",
      });
    } catch {
      throw new DevelopmentError(
        422,
        "reference_parse_failed",
        "The PDF could not be converted into expected answers. Check the parsing route, or use a structured JSON reference.",
      );
    }
    const validated = structuredReferenceSchema.safeParse(expected);
    compatibility =
      validated.success &&
      validated.data.section === input.section &&
      JSON.stringify([...validated.data.source_document_ids].sort()) ===
        JSON.stringify([...input.source_document_ids].sort())
        ? "compatible"
        : "incompatible";
    parsed = {
      document,
      expected_answers: validated.success ? validated.data : null,
      compatibility_reason:
        compatibility === "incompatible"
          ? "No valid section-specific expected answers were parsed. Upload a structured reference to enable reference-based measures."
          : null,
    };
    parser = completion.parser;
  }
  return {
    document: {
      ...makeDocument(experiment, actor, {
        filename: input.filename,
        mime: input.format === "pdf" ? "application/pdf" : "application/json",
        buffer,
        parsed,
        parser,
      }),
      role: "reference" as const,
      section: input.section,
      source_document_ids: input.source_document_ids,
      review_status:
        input.format === "pdf"
          ? ("provisional" as const)
          : ("unreviewed" as const),
      compatibility,
    },
    content_base64: buffer.toString("base64"),
  };
}
