/** Pure historical benchmark configuration and frozen caller-owned route contracts. */
import { z } from "zod";

const text = z.string().trim().min(1);
const money = z.number().finite().nonnegative().nullable();
const routeSchema = z.strictObject({
  configuration: z.enum(["baseline", "extract"]),
  stage: z.enum(["need_extract", "inventory_extract", "completeness_audit"]),
  providerId: text, requestedModel: text, actualModel: text.nullable(), version: text,
  tier: text, lowestCostSuitableTierVerified: z.boolean(),
  accountVerified: z.boolean(), versionVerified: z.boolean(),
  citationsVerified: z.boolean(), citationsEnabled: z.boolean(),
  authorizationEvidence: text.nullable(), settingsHash: text,
  credentialEnvName: z.string().regex(/^[A-Z][A-Z0-9_]*$/), fallbackAllowed: z.boolean(),
});

/** Initial full-experiment plan, not a resume plan. Explicit metadata only:
 * never put keys, source text, or DB connection strings here.
 */
export const benchmarkConfigSchema = z.strictObject({
  batchId: text, sourceCodeVersion: text, referenceVersion: text,
  goldReviewed: z.boolean(), repetitions: z.number().int().positive(),
  blockCap: z.number().int().positive().nullable(),
  storage: z.strictObject({ path: text, isolated: z.boolean(), gitIgnored: z.boolean(), exclusionEvidence: text.nullable() }),
  // All-synthetic fixtures are flexible; real runs require exactly both agreed BeOne packs.
  sources: z.array(z.strictObject({
    packId: text, hash: text, blocks: z.number().int().positive(),
    inputTokens: z.number().int().positive().nullable(), complete: z.boolean(), synthetic: z.boolean(),
  })).min(1),
  baselineSnapshot: text.nullable(), schemaHash: text, promptsHash: text, auditProcessHash: text,
  routes: z.array(routeSchema).min(1),
  // calls covers the full initial experiment including retries; spentUsd is prior incurred cost.
  // setupUsd/tuningUsd reserve additional costs. Downstream enforces remaining budget per attempt.
  budget: z.strictObject({
    ceilingUsd: z.number().finite().positive().max(10), spentUsd: money,
    pendingCost: z.boolean(), setupUsd: money, tuningUsd: money,
    priceAsOf: z.iso.date(), priceSource: text, sizeBasisHash: text,
    calls: z.array(z.strictObject({ label: text, count: z.number().int().positive(), maxUsd: money })).min(1),
  }),
  maxTemporaryRetries: z.number().int().nonnegative(),
});
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;
export type BenchmarkRoute = BenchmarkConfig["routes"][number];
/** Caller-supplied historical route snapshot, structurally matching the retained contract.
 * No live routing, credentials, or Accuracy runtime are loaded here.
 */
export type BaselineRouteSnapshot = {
  call_kind: "upload" | "parse" | "inventory_extract" | "need_extract" | "merge_dedupe" | "completeness_audit" | "pair_generate" | "coverage_decide" | "coverage_critic" | "validation_gate" | "partial_split" | "status_derive" | "prioritize" | "ideate" | "gantt_project";
  role: "proposer" | "critic" | "reviser" | "judge" | "none";
  provider_id: string;
  model: string;
  params: { temperature: number; max_tokens: number };
  fallbacks: string[];
  degraded: boolean;
  reason: string | null;
};
export type PreflightResult = {
  ready: boolean;
  blockers: string[];
  /** Conservative display total rounded upward to nine decimals; admission uses unrounded total. */
  estimatedTotalUsd: number | null;
};
