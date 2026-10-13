import { describe, expect, it } from "vitest";
import { checkPreflight } from "../src/accuracy/eval/benchmark/preflight";
import type { BenchmarkConfig } from "../src/accuracy/eval/benchmark/contracts";

function config(): BenchmarkConfig {
  return {
    batchId: "synthetic-1", sourceCodeVersion: "abc123", referenceVersion: "gold-v1",
    goldReviewed: true, repetitions: 3, blockCap: null,
    storage: { path: "data/runtime/benchmark/synthetic-1", isolated: true, gitIgnored: true, exclusionEvidence: "git check-ignore verified" },
    sources: [{ packId: "synthetic", hash: "sha256:test", blocks: 100, inputTokens: 1000, complete: true, synthetic: true }],
    baselineSnapshot: "resolved-runtime-snapshot-hash",
    schemaHash: "schema-v1", promptsHash: "prompts-v1", auditProcessHash: "audit-v1",
    routes: ["baseline", "extract"].flatMap(configuration =>
      (["need_extract", "inventory_extract", "completeness_audit"] as const).map(stage => ({
        configuration: configuration as "baseline" | "extract", stage, providerId: configuration,
        requestedModel: "fixed-model", actualModel: "fixed-model", version: configuration === "extract" ? "2.5" : "fixed",
        tier: "lowest", lowestCostSuitableTierVerified: true, accountVerified: true, versionVerified: true,
        citationsVerified: true, citationsEnabled: true, authorizationEvidence: null,
        settingsHash: "settings-v1", credentialEnvName: "BENCHMARK_KEY", fallbackAllowed: false,
      }))),
    budget: { ceilingUsd: 10, spentUsd: 0, pendingCost: false, setupUsd: 0.1, tuningUsd: 0,
      priceAsOf: "2026-10-13", priceSource: "verified-price-table", sizeBasisHash: "sha256:test",
      calls: [{ label: "all stages and retries", count: 36, maxUsd: 0.1 }] },
    maxTemporaryRetries: 1,
  };
}

describe("isolated benchmark preflight", () => {
  it("accepts a complete synthetic plan beyond 80 blocks", () => {
    expect(checkPreflight(config(), ["BENCHMARK_KEY"])).toMatchObject({ ready: true, blockers: [], estimatedTotalUsd: 3.7 });
  });
  function realConfig(packIds: string[]): BenchmarkConfig {
    const c = config();
    c.sources = packIds.map(packId => ({ ...c.sources[0], packId, hash: `sha256:${packId}`, synthetic: false }));
    c.routes.forEach(route => { route.authorizationEvidence = "documented provider-specific permission"; });
    c.budget.calls[0].count = 36 * c.sources.length;
    c.budget.sizeBasisHash = c.sources.map(source => source.hash).join(",");
    return c;
  }
  it("blocks an authorized plan containing only one agreed real deck", () => {
    expect(checkPreflight(realConfig(["beone-bgb-58067-prmt5i"]), ["BENCHMARK_KEY"]).ready).toBe(false);
  });
  it("accepts both agreed real decks with authorization and a full cost plan", () => {
    expect(checkPreflight(realConfig(["beone-bgb-58067-prmt5i", "beone-tislelizumab-iegp"]), ["BENCHMARK_KEY"]).ready).toBe(true);
  });
  it("blocks mixed real and synthetic packs even with authorization", () => {
    const c = realConfig(["beone-bgb-58067-prmt5i", "beone-tislelizumab-iegp"]);
    c.sources[1].synthetic = true;
    expect(checkPreflight(c, ["BENCHMARK_KEY"]).ready).toBe(false);
  });
  it("blocks a total fractionally above the ceiling before display rounding", () => {
    const c = config();
    c.budget.setupUsd = 0;
    c.budget.calls[0].maxUsd = 0;
    c.budget.spentUsd = 10.0000000001;
    const result = checkPreflight(c, ["BENCHMARK_KEY"]);
    expect(result.ready).toBe(false);
    expect(result.estimatedTotalUsd).toBeGreaterThanOrEqual(c.budget.spentUsd);
  });
  it("blocks a depleted call plan because this is initial readiness, not a resume gate", () => {
    const c = config();
    c.budget.calls[0].count = 35;
    c.budget.spentUsd = 0.1;
    expect(checkPreflight(c, ["BENCHMARK_KEY"]).ready).toBe(false);
  });
  it.each([
    ["gold", (c: BenchmarkConfig) => { c.goldReviewed = false; }],
    ["snapshot", (c: BenchmarkConfig) => { c.baselineSnapshot = null; }],
    ["complete", (c: BenchmarkConfig) => { c.sources[0].complete = false; }],
    ["cap", (c: BenchmarkConfig) => { c.blockCap = 80; }],
    ["repetitions", (c: BenchmarkConfig) => { c.repetitions = 2; }],
    ["account", (c: BenchmarkConfig) => { c.routes[0].accountVerified = false; }],
    ["citations", (c: BenchmarkConfig) => { c.routes[0].citationsVerified = false; }],
    ["version", (c: BenchmarkConfig) => { c.routes[3].version = "latest"; }],
    ["tier", (c: BenchmarkConfig) => { c.routes[3].lowestCostSuitableTierVerified = false; }],
    ["fallback", (c: BenchmarkConfig) => { c.routes[0].actualModel = "other"; }],
    ["authorization", (c: BenchmarkConfig) => { c.sources[0].synthetic = false; }],
    ["storage", (c: BenchmarkConfig) => { c.storage.gitIgnored = false; }],
    ["path", (c: BenchmarkConfig) => { c.storage.path = "data/runtime/../public"; }],
    ["unknown cost", (c: BenchmarkConfig) => { c.budget.spentUsd = null; }],
    ["pending cost", (c: BenchmarkConfig) => { c.budget.pendingCost = true; }],
    ["budget", (c: BenchmarkConfig) => { c.budget.calls[0].maxUsd = 1; }],
    ["underestimated calls", (c: BenchmarkConfig) => { c.budget.calls[0].count = 1; }],
    ["source cost mismatch", (c: BenchmarkConfig) => { c.budget.sizeBasisHash = "other"; }],
    ["retry", (c: BenchmarkConfig) => { c.maxTemporaryRetries = 2; }],
    ["route missing", (c: BenchmarkConfig) => { c.routes.pop(); }],
    ["token size", (c: BenchmarkConfig) => { c.sources[0].inputTokens = null; }],
  ] as const)("blocks %s", (_label, change) => {
    const c = config(); change(c);
    const result = checkPreflight(c, ["BENCHMARK_KEY"]);
    expect(result.ready).toBe(false); expect(result.blockers.length).toBeGreaterThan(0);
  });
  it("blocks missing credentials and deployed database environment names without reading values", () => {
    expect(checkPreflight(config(), ["DATABASE_URL"]).ready).toBe(false);
  });
  it("returns safe errors for invalid untrusted config without echoing input", () => {
    const result = checkPreflight({ secret: "never-echo" }, []);
    expect(result.ready).toBe(false); expect(JSON.stringify(result)).not.toContain("never-echo");
  });
});
