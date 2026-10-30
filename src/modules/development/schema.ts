/** Validated, versioned Development drafts and evaluator-only reference contracts. */
import { z } from "zod";
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(10000);
export const sectionSchema = z.enum([
  "gap_extraction",
  "tactic_extraction",
  "matching_coverage",
  "partial_splitting",
]);
export type DevelopmentSection = z.infer<typeof sectionSchema>;
export const createDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    source_workspace_id: id.nullable(),
  })
  .strict();
export const saveDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    revision: z.number().int().positive(),
  })
  .strict();
export const sourceImportSchema = z
  .object({ revision: z.number().int().positive(), source_file_id: id })
  .strict();
export const sourceUploadSchema = z
  .object({
    revision: z.number().int().positive(),
    filename: z.string().trim().min(1).max(255),
    content_base64: z.string().min(1),
  })
  .strict();
export const referenceUploadSchema = sourceUploadSchema
  .extend({
    format: z.enum(["pdf", "structured"]),
    section: sectionSchema,
    source_document_ids: z.array(id).min(1).max(100),
  })
  .strict();
const common = { id, source_document_id: id };
const answerSchemas = {
  gap_extraction: z
    .object({ ...common, statement: text, quote: text })
    .strict(),
  tactic_extraction: z
    .object({ ...common, title: text, description: text, quote: text })
    .strict(),
  matching_coverage: z
    .object({
      ...common,
      gap_id: id,
      tactic_id: id,
      relevance: z.enum(["relevant", "irrelevant"]),
      coverage: z.enum(["addressed", "partial", "open"]),
      rationale: text,
    })
    .strict(),
  partial_splitting: z
    .object({
      ...common,
      parent_gap_id: id,
      addressed_statement: text,
      residual_statement: text,
      tactic_ids: z.array(id).min(1).max(100),
    })
    .strict(),
};
export const structuredReferenceSchema = z
  .object({
    version: z.literal(1),
    section: sectionSchema,
    source_document_ids: z.array(id).min(1).max(100),
    expected_answers: z.array(z.unknown()).min(1).max(2000),
  })
  .strict()
  .transform((value, ctx) => {
    const expected_answers: z.infer<
      (typeof answerSchemas)[DevelopmentSection]
    >[] = [];
    const seen = new Set<string>();
    if (
      new Set(value.source_document_ids).size !==
      value.source_document_ids.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Source associations must be unique.",
      });
    value.expected_answers.forEach((raw, index) => {
      const result = answerSchemas[value.section].safeParse(raw);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["expected_answers", index],
          message: `Invalid ${value.section} answer.`,
        });
        return;
      }
      expected_answers.push(result.data);
      if (seen.has(result.data.id))
        ctx.addIssue({ code: "custom", message: "Answer IDs must be unique." });
      seen.add(result.data.id);
      if (!value.source_document_ids.includes(result.data.source_document_id))
        ctx.addIssue({
          code: "custom",
          message: "Each answer must refer to an associated source snapshot.",
        });
    });
    return { ...value, expected_answers };
  });
export type StructuredReference = z.infer<typeof structuredReferenceSchema>;
export type ParserIdentity = {
  name: string;
  version: string;
  model: string | null;
  prompt: string | null;
  run_id?: string;
  provider_id?: string;
};
export type DevelopmentDocument = {
  id: string;
  experiment_id: string;
  role: "source" | "reference";
  origin: "workspace" | "private";
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  parsed_sha256: string;
  parsed: unknown;
  parser: ParserIdentity;
  created_by: string;
  created_at: string;
  original_owner: string;
  original_created_at: string;
  parsed_at: string;
  source_workspace_id: string | null;
  source_file_id: string | null;
  section: DevelopmentSection | null;
  source_document_ids: string[];
  review_status: "not_applicable" | "unreviewed" | "provisional";
  compatibility: "compatible" | "incompatible";
};
export type Experiment = {
  id: string;
  name: string;
  source_workspace_id: string | null;
  owner: string;
  revision: number;
  status: "draft";
  created_at: string;
  updated_at: string;
  documents: DevelopmentDocument[];
};
/** A safe, actionable failure suitable for an owner-facing API. */
export class DevelopmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DevelopmentError";
  }
}
