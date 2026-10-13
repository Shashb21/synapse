import { benchmarkConfigSchema, type PreflightResult } from "./contracts";

/** Pure gate. Caller supplies environment NAMES, never environment values. No I/O. */
export function checkPreflight(config: unknown, envNames: readonly string[]): PreflightResult {
  const parsed = benchmarkConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { ready: false, blockers: ["Invalid benchmark configuration; supply all explicit metadata fields."], estimatedTotalUsd: null };
  }
  const c = parsed.data;
  const blockers: string[] = [];
  const require = (ok: boolean, message: string) => { if (!ok) blockers.push(message); };
  require(!envNames.some(name => /DATABASE|POSTGRES|^PG|SUPABASE|DB_URL|DB_HOST|DB_PASSWORD/i.test(name)), "Remove database environment credentials from the isolated process.");
  require(c.storage.isolated && c.storage.gitIgnored && Boolean(c.storage.exclusionEvidence), "Private isolated storage and verified Git exclusion are required.");
  require(/^data\/runtime\/benchmark\/[A-Za-z0-9_-]+$/.test(c.storage.path) && c.storage.path.endsWith(`/${c.batchId}`), "Storage must be a per-batch data/runtime/benchmark directory without traversal.");
  require(c.goldReviewed, "Human-reviewed frozen gold is pending.");
  require(Boolean(c.baselineSnapshot), "Actual resolved runtime baseline snapshot is pending; defaults are insufficient.");
  require(c.repetitions === 3, "Exactly three scored repetitions are required.");
  require(c.blockCap === null, "Primary comparison must preserve full input without a block cap.");
  require(c.maxTemporaryRetries <= 1, "At most one temporary-service retry is permitted.");
  require(new Set(c.sources.map(s => s.packId)).size === c.sources.length, "Keep source packs separate with unique pack identities.");
  for (const source of c.sources) {
    require(source.complete, `${source.packId}: frozen complete parsed source required.`);
    require(source.inputTokens !== null, `${source.packId}: actual input token size is unknown.`);
  }
  for (const configuration of ["baseline", "extract"] as const) {
    for (const stage of ["need_extract", "inventory_extract", "completeness_audit"] as const) {
      require(c.routes.filter(r => r.configuration === configuration && r.stage === stage).length === 1, `${configuration}/${stage}: exactly one fixed route required.`);
    }
  }
  for (const r of c.routes) {
    const label = `${r.configuration}/${r.stage}`;
    require(envNames.includes(r.credentialEnvName), `${label}: credential environment name missing.`);
    require(r.accountVerified && r.versionVerified, `${label}: account/version verification pending.`);
    require(r.citationsEnabled && r.citationsVerified, `${label}: citation support verification pending.`);
    require(r.actualModel === r.requestedModel && !r.fallbackAllowed, `${label}: responding model must match the fixed request; fallback results need a separate label.`);
    if (r.configuration === "extract") {
      require(r.version === "2.5", `${label}: fixed Extract version 2.5 required.`);
      require(r.lowestCostSuitableTierVerified, `${label}: lowest-cost suitable tier verification pending.`);
    }
    require(c.sources.every(s => s.synthetic) || Boolean(r.authorizationEvidence), `${label}: vendor-specific BeOne processing authorization pending.`);
  }
  const b = c.budget;
  const plannedCalls = c.routes.length * c.sources.length * c.repetitions * (1 + c.maxTemporaryRetries);
  require(b.calls.reduce((sum, call) => sum + call.count, 0) >= plannedCalls, "Cost plan must cover all decks, routes, repetitions and permitted retries; setup and tuning are additional reserves.");
  const known = b.spentUsd !== null && b.setupUsd !== null && b.tuningUsd !== null && !b.pendingCost && b.calls.every(call => call.maxUsd !== null);
  const estimatedTotalUsd = known
    ? Math.round(((b.spentUsd ?? 0) + (b.setupUsd ?? 0) + (b.tuningUsd ?? 0) + b.calls.reduce((sum, call) => sum + call.count * (call.maxUsd ?? 0), 0)) * 1e9) / 1e9
    : null;
  require(known, "Unknown or pending costs block paid execution; unknown is not zero.");
  require(estimatedTotalUsd !== null && estimatedTotalUsd <= b.ceilingUsd, "Conservative whole-experiment estimate must fit the remaining US$10 ceiling.");
  require(b.sizeBasisHash === c.sources.map(s => s.hash).join(","), "Cost estimate must identify the exact frozen source hashes in source order.");
  return { ready: blockers.length === 0, blockers, estimatedTotalUsd };
}
