import { z } from "zod";
import type { ResolvedAccuracyRoute } from "../../kernel/contracts";

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

/** Explicit metadata only: never put keys, source text, or DB connection strings here. */
export const benchmarkConfigSchema = z.strictObject({
  batchId: text, sourceCodeVersion: text, referenceVersion: text,
  goldReviewed: z.boolean(), repetitions: z.number().int().positive(),
  blockCap: z.number().int().positive().nullable(),
  storage: z.strictObject({ path: text, isolated: z.boolean(), gitIgnored: z.boolean(), exclusionEvidence: text.nullable() }),
  sources: z.array(z.strictObject({
    packId: text, hash: text, blocks: z.number().int().positive(),
    inputTokens: z.number().int().positive().nullable(), complete: z.boolean(), synthetic: z.boolean(),
  })).min(1),
  baselineSnapshot: text.nullable(), schemaHash: text, promptsHash: text, auditProcessHash: text,
  routes: z.array(routeSchema).min(1),
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
/** Reuse the existing resolved contract for caller-supplied runtime snapshots. */
export type BaselineRouteSnapshot = Pick<ResolvedAccuracyRoute,
  "call_kind" | "role" | "provider_id" | "model" | "params" | "fallbacks" | "degraded" | "reason">;
export type PreflightResult = {
  ready: boolean;
  blockers: string[];
  estimatedTotalUsd: number | null;
};
