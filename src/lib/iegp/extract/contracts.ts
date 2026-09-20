import { z } from "zod";
import { EVIDENCE_DOMAINS } from "@/lib/iegp/enums";

export const GAP_EXTRACT_ROUNDS = 3;
export const GAP_EXTRACT_CAP = 40;
export const GAP_EXTRACT_CHAMPION_ID = "default";

export const picoSchema = z.object({
  population: z.string().default("To be specified"),
  intervention: z.string().default("To be specified"),
  comparator: z.string().default("To be specified"),
  outcome: z.string().default("To be specified"),
  geography: z.string().default("To be specified"),
  timing: z.string().default("To be specified"),
});

export const extractNeedSchema = z.object({
  statement: z.string().min(12),
  source_quote: z.string().min(1),
  source_location: z.string().optional(),
  is_gap: z.boolean().optional(),
});

export const extractGapSchema = z.object({
  name: z.string().min(3),
  statement: z.string().min(12),
  domain: z.string().min(2),
  domain_rationale: z.string().optional(),
  source_quote: z.string().min(1),
  source_location: z.string().optional(),
  needs: z.array(extractNeedSchema).default([]),
  pico: picoSchema.optional(),
  decision_supported: z.string().optional(),
  stakeholder: z.string().optional(),
  extra: z.record(z.string(), z.string()).optional(),
});

export const proposerPayloadSchema = z.object({
  gaps: z.array(extractGapSchema).default([]),
  needs: z.array(extractNeedSchema).default([]),
  notes: z.array(z.string()).optional(),
});

export const criticFindingKind = z.enum([
  "partial",
  "wrong",
  "missed",
  "new",
  "mashed",
  "ungrounded",
  "generic",
  "tactic_not_gap",
  "quote_as_gap",
  "not_a_gap",
]);

export const criticFindingSchema = z.object({
  kind: criticFindingKind,
  gap_name: z.string().optional(),
  statement: z.string(),
  rationale: z.string(),
  gold_id: z.string().optional(),
});

export const criticPayloadSchema = z.object({
  findings: z.array(criticFindingSchema).default([]),
  summary: z.string().optional(),
});

export const judgeActionSchema = z.enum(["keep", "drop", "split", "merge"]);

export const judgeDecisionSchema = z.object({
  name: z.string(),
  action: judgeActionSchema,
  rationale: z.string(),
  merge_into: z.string().optional(),
});

export const judgePayloadSchema = z.object({
  decisions: z.array(judgeDecisionSchema).default([]),
  gaps: z.array(extractGapSchema).default([]),
  needs: z.array(extractNeedSchema).default([]),
  rationale: z.string().optional(),
});

export const improverPayloadSchema = z.object({
  recommended_prompt_version: z.string(),
  rationale: z.array(z.string()).default([]),
  prompt_patch: z.string().default(""),
  system_prompt: z.string().optional(),
});

export type PicoFields = z.infer<typeof picoSchema>;
export type ExtractNeed = z.infer<typeof extractNeedSchema>;
export type ExtractGap = z.infer<typeof extractGapSchema>;
export type ProposerPayload = z.infer<typeof proposerPayloadSchema>;
export type CriticFinding = z.infer<typeof criticFindingSchema>;
export type CriticPayload = z.infer<typeof criticPayloadSchema>;
export type JudgePayload = z.infer<typeof judgePayloadSchema>;
export type ImproverPayload = z.infer<typeof improverPayloadSchema>;

export type NormalizedBlock = {
  id: string;
  heading: string;
  text: string;
  location: string;
  kind: string;
};

export type NormalizedSource = {
  title: string;
  filename: string;
  format: "markdown" | "json";
  full_text: string;
  blocks: NormalizedBlock[];
};

export type ExtractRoundTrace = {
  round: number;
  proposer: ProposerPayload;
  critic: CriticPayload;
  proposer_ms: number;
  critic_ms: number;
};

export type GapExtractResult = {
  prompt_version: string;
  rounds: ExtractRoundTrace[];
  judge: JudgePayload;
  judge_ms: number;
  gaps: ExtractGap[];
  needs: ExtractNeed[];
};

export function coerceEvidenceDomain(raw: string): (typeof EVIDENCE_DOMAINS)[number] {
  const key = raw.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
  if ((EVIDENCE_DOMAINS as readonly string[]).includes(key)) {
    return key as (typeof EVIDENCE_DOMAINS)[number];
  }
  const aliases: Record<string, (typeof EVIDENCE_DOMAINS)[number]> = {
    ce: "comparative_effectiveness",
    comparative: "comparative_effectiveness",
    qol: "qol_pro",
    pro: "qol_pro",
    quality_of_life: "qol_pro",
    ira: "budget_impact",
    bim: "budget_impact",
    cea: "cost_effectiveness",
    sequencing: "treatment_sequencing",
    persistence: "adherence",
    discontinuation: "adherence",
    cns: "efficacy",
    intracranial: "efficacy",
    ild: "safety",
    os: "long_term_outcomes",
    overall_survival: "long_term_outcomes",
    elderly: "subpopulations",
    hta: "unmet_need",
  };
  if (aliases[key]) return aliases[key];
  const hit = EVIDENCE_DOMAINS.find((d) => key.includes(d) || d.includes(key));
  return hit ?? "unmet_need";
}
