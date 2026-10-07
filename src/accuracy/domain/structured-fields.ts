import { z } from "zod";
import { createHash } from "node:crypto";
import type { AccuracyClaimRow } from "@/accuracy/store/claim-store";
import { provenanceSpanSchema, validateProvenance, type ParseBlock, type ProvenanceSpan } from "@/accuracy/store/quote-validator";
import { EVIDENCE_DOMAINS, SOURCE_EVIDENCE_CATEGORY_DOMAINS } from "@/lib/iegp/enums";

export type StructuredField<T> =
  | { state: "known"; value: T; provenance: ProvenanceSpan[] }
  | { state: "unknown"; value: null; reason: string; provenance: [] };

export function unknownField(reason: string): StructuredField<never> {
  return { state: "unknown", value: null, reason, provenance: [] };
}

export function structuredFieldSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), value, provenance: z.array(provenanceSpanSchema).min(1) }).strict(),
    z.object({ state: z.literal("unknown"), value: z.null(), reason: z.string().trim().min(1),
      provenance: z.tuple([]) }).strict(),
  ]);
}

const textField = structuredFieldSchema(z.string().trim().min(1));
const lifecycleField = structuredFieldSchema(z.enum(["completed", "ongoing", "planned", "proposed", "cancelled"]));

const categoryValueSchema = z.object({
  source_label: z.enum(["clinical efficacy", "safety", "PRO", "HRQoL", "HEOR", "epidemiology", "biomarkers", "guidelines", "access"]),
  evidence_domain: z.enum(EVIDENCE_DOMAINS).optional(),
}).strict().refine(value => value.evidence_domain === undefined
  || value.evidence_domain === SOURCE_EVIDENCE_CATEGORY_DOMAINS[value.source_label], "category_domain_mismatch")
  .transform(value => ({ ...value, evidence_domain: SOURCE_EVIDENCE_CATEGORY_DOMAINS[value.source_label] }));

const documentSchema = z.object({ title: z.string().trim().min(1), document_id: z.string().trim().min(1).nullable(),
  resolution: z.enum(["resolved", "unresolved"]), source_file_id: z.string().min(1).nullable() }).strict()
  .refine(value => (value.resolution === "resolved") === (value.source_file_id !== null), "document_resolution_mismatch");

const interviewQuoteSchema = z.object({ quote: provenanceSpanSchema,
  speaker: textField, role: textField }).strict();

export const gapStructuredFieldsSchema = z.object({
  version: z.literal(1),
  description: textField.default(() => unknownField("legacy_missing")),
  indication: textField.default(() => unknownField("legacy_missing")),
  disease_setting: textField.default(() => unknownField("legacy_missing")),
  category: structuredFieldSchema(categoryValueSchema).default(() => unknownField("legacy_missing")),
  rationale: textField.default(() => unknownField("legacy_missing")),
  supporting_documents: structuredFieldSchema(z.array(documentSchema).min(1)).default(() => unknownField("legacy_missing")),
  interview_quotes: structuredFieldSchema(z.array(interviewQuoteSchema).min(1)).default(() => unknownField("legacy_missing")),
}).strict();

export type GapStructuredFields = z.infer<typeof gapStructuredFieldsSchema>;

export const tacticStructuredFieldsSchema = z.object({
  version: z.literal(1),
  description: textField.default(() => unknownField("legacy_missing")),
  objective: textField.default(() => unknownField("legacy_missing")),
  owner: textField.default(() => unknownField("legacy_missing")),
  timing: textField.default(() => unknownField("legacy_missing")),
  outputs: structuredFieldSchema(z.array(z.string().trim().min(1)).min(1)).default(() => unknownField("legacy_missing")),
  lifecycle: lifecycleField.default(() => unknownField("legacy_missing")),
}).strict();

export type TacticStructuredFields = z.infer<typeof tacticStructuredFieldsSchema>;

export function emptyTacticStructuredFields(reason = "legacy_missing"): TacticStructuredFields {
  return { version: 1, description: unknownField(reason), objective: unknownField(reason), owner: unknownField(reason),
    timing: unknownField(reason), outputs: unknownField(reason), lifecycle: unknownField(reason) };
}

export function emptyGapStructuredFields(reason = "legacy_missing"): GapStructuredFields {
  return { version: 1, description: unknownField(reason), indication: unknownField(reason), disease_setting: unknownField(reason),
    category: unknownField(reason), rationale: unknownField(reason), supporting_documents: unknownField(reason),
    interview_quotes: unknownField(reason) };
}

/** Read normalization is pure; it neither fabricates legacy facts nor revalidates rows. */
export function readStructuredFields(claim: AccuracyClaimRow & { claim_type: "tactic" }): TacticStructuredFields;
export function readStructuredFields(claim: AccuracyClaimRow & { claim_type: "gap" }): GapStructuredFields;
export function readStructuredFields(claim: AccuracyClaimRow): GapStructuredFields | TacticStructuredFields;
export function readStructuredFields(claim: AccuracyClaimRow): GapStructuredFields | TacticStructuredFields {
  const schema = claim.claim_type === "tactic" ? tacticStructuredFieldsSchema : gapStructuredFieldsSchema;
  const empty = claim.claim_type === "tactic" ? emptyTacticStructuredFields() : emptyGapStructuredFields();
  const raw = (claim.metadata as Record<string, unknown> | null)?.structured;
  if (!raw || typeof raw !== "object") return empty;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return claim.claim_type === "tactic"
    ? emptyTacticStructuredFields("unsupported_version") : emptyGapStructuredFields("unsupported_version");
  const normalized: Record<string, unknown> = { version: 1 };
  for (const [key, field] of Object.entries(schema.shape)) {
    if (key === "version") continue;
    const result = field.safeParse(record[key]);
    normalized[key] = result.success ? result.data : unknownField("invalid_stored_field");
  }
  return normalized as GapStructuredFields | TacticStructuredFields;
}

export const rejectedCandidateSchema = z.object({ index: z.number().int().nonnegative(), field: z.string(), reason: z.string() });
export type RejectedCandidate = z.infer<typeof rejectedCandidateSchema>;
export type FieldEvidenceError = { field: string; reason: string };

/** Restrict every factual span to the original selected blocks of this source. */
export function validateFieldEvidence(args: {
  structured: GapStructuredFields | TacticStructuredFields;
  provenance: ProvenanceSpan[];
  source_file_id: string;
  source_file_ids?: ReadonlySet<string>;
  blocks: Pick<ParseBlock, "id" | "source_file_id" | "text">[];
  /** Only server-resolved, workspace-scoped documents may have a file link. */
  resolved_source_ids?: ReadonlySet<string>;
}): FieldEvidenceError | null {
  const byId = new Map(args.blocks.map(block => [block.id, block]));
  const spans: Array<{ field: string; span: ProvenanceSpan }> = args.provenance.map(span => ({ field: "provenance", span }));
  for (const [key, raw] of Object.entries(args.structured)) {
    if (key === "version") continue;
    const field = raw as StructuredField<unknown>;
    if (field.state === "known") spans.push(...field.provenance.map(span => ({ field: `structured.${key}`, span })));
  }
  if ("interview_quotes" in args.structured && args.structured.interview_quotes.state === "known") {
    for (const [index, quote] of args.structured.interview_quotes.value.entries()) {
      const path = `structured.interview_quotes.${index}`;
      spans.push({ field: `${path}.quote`, span: quote.quote });
      for (const key of ["speaker", "role"] as const) {
        const field = quote[key];
        if (field.state === "unknown") continue;
        spans.push(...field.provenance.map(span => ({ field: `${path}.${key}`, span })));
        if (!field.provenance.some(span => span.quote.includes(field.value))) {
          return { field: `${path}.${key}`, reason: "attribution_not_in_evidence" };
        }
      }
    }
  }
  for (const { field, span } of spans) {
    if (!(args.source_file_ids?.has(span.source_file_id) ?? (span.source_file_id === args.source_file_id))) return { field, reason: "source_file_mismatch" };
    const block = byId.get(span.block_id);
    if (!block) return { field, reason: "block_not_permitted" };
    const result = validateProvenance({ block: block as ParseBlock, span });
    if (!result.ok) return { field, reason: result.reason };
  }
  if ("supporting_documents" in args.structured && args.structured.supporting_documents.state === "known") {
    const field = args.structured.supporting_documents;
    for (const document of field.value) {
      if (!field.provenance.some(span => span.quote.includes(document.title)
        || (document.document_id !== null && span.quote.includes(document.document_id)))) {
        return { field: "structured.supporting_documents", reason: "document_not_in_evidence" };
      }
      if (document.resolution === "resolved" && !args.resolved_source_ids?.has(document.source_file_id!)) {
        return { field: "structured.supporting_documents", reason: "document_resolution_unverified" };
      }
    }
  }
  return null;
}

export const gapStructuredPatchSchema = z.object({
  description: gapStructuredFieldsSchema.shape.description.removeDefault().optional(),
  indication: gapStructuredFieldsSchema.shape.indication.removeDefault().optional(),
  disease_setting: gapStructuredFieldsSchema.shape.disease_setting.removeDefault().optional(),
  category: gapStructuredFieldsSchema.shape.category.removeDefault().optional(),
  rationale: gapStructuredFieldsSchema.shape.rationale.removeDefault().optional(),
  supporting_documents: gapStructuredFieldsSchema.shape.supporting_documents.removeDefault().optional(),
  interview_quotes: gapStructuredFieldsSchema.shape.interview_quotes.removeDefault().optional(),
}).strict();
export const tacticStructuredPatchSchema = z.object({
  description: tacticStructuredFieldsSchema.shape.description.removeDefault().optional(),
  objective: tacticStructuredFieldsSchema.shape.objective.removeDefault().optional(),
  owner: tacticStructuredFieldsSchema.shape.owner.removeDefault().optional(),
  timing: tacticStructuredFieldsSchema.shape.timing.removeDefault().optional(),
  outputs: tacticStructuredFieldsSchema.shape.outputs.removeDefault().optional(),
  lifecycle: tacticStructuredFieldsSchema.shape.lifecycle.removeDefault().optional(),
}).strict();
export const structuredPatchSchema = z.union([gapStructuredPatchSchema, tacticStructuredPatchSchema]);
export type StructuredPatch = z.input<typeof structuredPatchSchema>;

type FactualClaim = Pick<AccuracyClaimRow, "id" | "workspace_id" | "claim_type" | "statement" | "source_file_id" | "status" | "metadata">;
const FACTUAL_META_KEYS = ["external_id", "identifier", "chapter", "si_theme", "reference_pack_id", "origin",
  "evidence_question", "design_summary", "start", "end", "readout", "readout_date", "evidence_available",
  "depends_on", "gap_ids", "parent_gap_id", "description", "indication", "disease_setting", "category",
  "evidence_domain", "rationale", "supporting_documents", "interview_quotes", "objective", "owner", "timing", "outputs"];

/** Stable decision-input token, independent of validation, audit and timestamps. No universe/list cap. */
export function claimFactualRevision(claim: FactualClaim): string {
  const meta = (claim.metadata ?? {}) as Record<string, unknown>;
  const lifecycle = typeof meta.tactic_status === "string" ? meta.tactic_status
    : ["completed", "ongoing", "planned", "proposed", "cancelled", "unknown"].includes(claim.status) ? claim.status : "unknown";
  const inputs = { id: claim.id, workspace_id: claim.workspace_id, claim_type: claim.claim_type,
    statement: claim.statement, source_file_id: claim.source_file_id, provenance: meta.provenance ?? [],
    structured: readStructuredFields(claim as AccuracyClaimRow),
    type: meta.type ?? meta.tactic_type ?? null, lifecycle: claim.claim_type === "tactic" ? lifecycle : null,
    fields: Object.fromEntries(FACTUAL_META_KEYS.map(key => [key, meta[key] ?? null])) };
  return createHash("sha256").update(JSON.stringify(inputs, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}

export function claimValidationFreshness(claim: Pick<AccuracyClaimRow, "validated"> & FactualClaim): "current" | "stale" | "unknown" | "unvalidated" {
  const metadata = (claim.metadata ?? {}) as Record<string, unknown>;
  const validation = metadata.validation as { factual_revision?: string; stale?: boolean } | undefined;
  if (validation?.stale || metadata.factual_validation_stale === true) return "stale";
  if (!claim.validated) return "unvalidated";
  if (!validation?.factual_revision) return "unknown";
  return validation.factual_revision === claimFactualRevision(claim) ? "current" : "stale";
}

/** Carry missing source facts into the survivor; existing facts win and remain reviewable. */
export function mergeStructuredFields<T extends GapStructuredFields | TacticStructuredFields>(survivor: T, additions: T[]): T {
  const result = { ...survivor } as Record<string, unknown>;
  for (const addition of additions) {
    for (const key of Object.keys(survivor)) {
      if (key === "version") continue;
      const current = result[key] as StructuredField<unknown>;
      const next = (addition as Record<string, unknown>)[key] as StructuredField<unknown> | undefined;
      if (current.state === "unknown" && next?.state === "known") result[key] = next;
    }
  }
  return result as T;
}

/** All cited spans, including document/quote attribution evidence, for the existing parse-edit owner. */
export function structuredProvenance(structured: unknown): ProvenanceSpan[] {
  const spans: ProvenanceSpan[] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const parsed = provenanceSpanSchema.safeParse(value);
    if (parsed.success) { spans.push(parsed.data); return; }
    Object.values(value).forEach(collect);
  };
  collect(structured);
  return spans;
}
