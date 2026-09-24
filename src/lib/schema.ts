import { z } from "zod";

export const STAKEHOLDER_FUNCTIONS = [
  "commercial",
  "market_access",
  "medical_affairs",
  "clinops",
  "marketing",
  "heor",
  "regulatory",
] as const;

export type StakeholderFunction = (typeof STAKEHOLDER_FUNCTIONS)[number];

export const INSIGHT_CLASSES = ["known", "unknown", "opportunity"] as const;
export type InsightClass = (typeof INSIGHT_CLASSES)[number];

export const INSIGHT_STATUSES = [
  "candidate",
  "accepted",
  "rejected",
  "partial",
] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export const PROMPT_VERSIONS = [
  "v1.0-baseline",
  "v1.1-atomic",
  "v1.2-gap-sensitive",
  "v1.3-cross-functional",
] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

export const EXTRACT_STRATEGIES = [
  "bullet-only",
  "claim-split",
  "gap-scan",
  "full",
] as const;
export type ExtractStrategy = (typeof EXTRACT_STRATEGIES)[number];

export const LOCATION_KINDS = [
  "slide",
  "page",
  "sheet",
  "section",
  "cell",
] as const;

export const sourceLocationSchema = z.object({
  kind: z.enum(LOCATION_KINDS),
  ref: z.string().min(1),
});

export const parsedBlockSchema = z.object({
  id: z.string(),
  location: sourceLocationSchema,
  heading: z.string().optional(),
  text: z.string(),
  kind: z.enum([
    "title",
    "heading",
    "bullet",
    "paragraph",
    "table_cell",
    "cell",
    "chart",
    "figure",
  ]),
});

export const parsedDocumentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  title: z.string(),
  stakeholder_function: z.enum(STAKEHOLDER_FUNCTIONS),
  mime: z.string(),
  parser: z.enum(["llamaparse", "local", "seed", "llm"]),
  ingested_at: z.string(),
  blocks: z.array(parsedBlockSchema),
  fullText: z.string(),
});

export const themeLinkSchema = z.object({
  insight_id: z.string(),
  theme_id: z.string(),
  score: z.number(),
  role: z.enum(["primary", "secondary"]),
  method: z.enum([
    "ontology",
    "stakeholder_prior",
    "residual",
    "catalog_accept",
  ]),
});

export const canonicalInsightSchema = z.object({
  id: z.string(),
  statement: z.string().min(12),
  evidence_quote: z.string().min(1),
  source_document_id: z.string(),
  source_location: sourceLocationSchema,
  stakeholder_function: z.enum(STAKEHOLDER_FUNCTIONS),
  theme_ids: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  classification: z.enum(INSIGHT_CLASSES),
  knowledge_state: z.object({
    corroborated_by: z.array(z.string()),
    contradicted_by: z.array(z.string()),
    evidence_strength: z.enum(["single_source", "multi_source", "triangulated"]),
  }),
  tags: z.array(z.string()),
  extracted_at: z.string(),
  extractor_prompt_version: z.string(),
  status: z.enum(INSIGHT_STATUSES),
});

export const goldInsightSchema = z.object({
  id: z.string(),
  statement: z.string(),
  source_document_id: z.string(),
  classification: z.enum(INSIGHT_CLASSES),
  stakeholder_function: z.enum(STAKEHOLDER_FUNCTIONS),
  theme_ids: z.array(z.string()).min(1),
  must_find: z.boolean(),
});

export const themeSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
  insight_ids: z.array(z.string()),
  known_count: z.number(),
  unknown_count: z.number(),
  opportunity_count: z.number(),
  parent_theme_id: z.string().optional(),
});

export const catalogThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
  parent_theme_id: z.string().optional(),
});

export const catalogProposalSchema = z.object({
  id: z.string(),
  kind: z.enum(["emerge", "split"]),
  status: z.enum(["proposed", "accepted", "rejected"]),
  name: z.string(),
  summary: z.string(),
  keywords: z.array(z.string()),
  insight_ids: z.array(z.string()),
  parent_theme_id: z.string().optional(),
  rationale: z.string(),
  sources: z.number(),
  cohesion: z.number(),
  created_at: z.string(),
  decided_at: z.string().optional(),
});

export const evalMetricsSchema = z.object({
  precision: z.number(),
  recall: z.number(),
  f1: z.number(),
  partial_rate: z.number(),
  wrong_rate: z.number(),
  missed_rate: z.number(),
  new_rate: z.number(),
  composite: z.number(),
  matched: z.number(),
  partial: z.number(),
  wrong: z.number(),
  missed: z.number(),
  novel: z.number(),
  extracted_count: z.number(),
  gold_count: z.number(),
});

export const critiqueFindingSchema = z.object({
  kind: z.enum(["partial", "wrong", "missed", "new"]),
  insight_id: z.string().optional(),
  gold_id: z.string().optional(),
  statement: z.string(),
  rationale: z.string(),
});

export const judgeVerdictSchema = z.object({
  decision: z.enum(["promote", "hold", "regress"]),
  champion_version: z.string(),
  candidate_version: z.string(),
  rationale: z.string(),
  safety_gate_passed: z.boolean(),
});

export const evalRunSchema = z.object({
  id: z.string(),
  ran_at: z.string(),
  prompt_version: z.string(),
  strategy: z.enum(EXTRACT_STRATEGIES),
  metrics: evalMetricsSchema,
  critique: z.array(critiqueFindingSchema),
  judge: judgeVerdictSchema,
  proposal: z.object({
    recommended_prompt_version: z.string(),
    rationale: z.array(z.string()),
    prompt_patch: z.string(),
  }),
});

export const engineStateSchema = z.object({
  asset: z.object({
    name: z.string(),
    molecule: z.string(),
    indication: z.string(),
    as_of: z.string(),
  }),
  champion_prompt_version: z.string(),
  documents: z.array(parsedDocumentSchema),
  insights: z.array(canonicalInsightSchema),
  theme_links: z.array(themeLinkSchema),
  themes: z.array(themeSchema),
  eval_runs: z.array(evalRunSchema),
  gold: z.array(goldInsightSchema),
  catalog: z.array(catalogThemeSchema).default([]),
  catalog_proposals: z.array(catalogProposalSchema).default([]),
});

export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type ParsedBlock = z.infer<typeof parsedBlockSchema>;
export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;
export type CanonicalInsight = z.infer<typeof canonicalInsightSchema>;
export type ThemeLink = z.infer<typeof themeLinkSchema>;
export type GoldInsight = z.infer<typeof goldInsightSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type CatalogTheme = z.infer<typeof catalogThemeSchema>;
export type CatalogProposal = z.infer<typeof catalogProposalSchema>;
export type EvalMetrics = z.infer<typeof evalMetricsSchema>;
export type CritiqueFinding = z.infer<typeof critiqueFindingSchema>;
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;
export type EvalRun = z.infer<typeof evalRunSchema>;
export type EngineState = z.infer<typeof engineStateSchema>;

export const FUNCTION_LABELS: Record<StakeholderFunction, string> = {
  commercial: "Commercial",
  market_access: "Market Access",
  medical_affairs: "Medical Affairs",
  clinops: "ClinOps",
  marketing: "Marketing",
  heor: "HEOR",
  regulatory: "Regulatory",
};

export const CLASS_LABELS: Record<InsightClass, string> = {
  known: "Known",
  unknown: "Unknown",
  opportunity: "Opportunity",
};
