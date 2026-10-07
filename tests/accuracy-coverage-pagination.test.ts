import { afterAll, describe, expect, it, vi } from "vitest";
import { createOrganization, createWorkspace, getWorkspace } from "@/accuracy/store/tenant";
import { getClaim, insertClaim, persistClaimPatch } from "@/accuracy/store/claim-store";
import { listCoveragePage, listCoveragePairs, upsertCoverageDecision, saveCoverageAssessment,
  coveragePairRevisions, rejectCoveragePair, listCoverageJoins } from "@/accuracy/store/coverage-store";
import { assessCoveragePage } from "@/accuracy/store/coverage-store";
import { accuracyTransactionActive, accuracyDb, withAccuracyTransaction, withAccuracyWorkspaceMutation } from "@/accuracy/store/db";
import { COVERAGE_PAIR_MIGRATION } from "@/accuracy/store/schema";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { AiDisabledError } from "@/modules/kernel/ai-switch";
import { AccuracyPausedError } from "@/accuracy/kernel/omission-pause";
import { sql } from "drizzle-orm";

// Exercise real concurrent backend connections rather than Vitest's single-connection queue.
vi.stubEnv("VITEST", "");
afterAll(() => vi.unstubAllEnvs());

async function workspace() {
  const org_id = await createOrganization("coverage paging");
  return createWorkspace({ org_id, name: "Coverage", slug: `cov-${crypto.randomUUID()}` });
}

describe("exhaustive coverage assessment", () => {
  it("includes every unlinked tactic beyond the first hundred pairs", async () => {
    const workspace_id = await workspace();
    await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    for (let n = 0; n < 101; n++) {
      await insertClaim({ workspace_id, claim_type: "tactic", statement: `Inventory ${n}` });
    }
    expect(await listCoveragePairs(workspace_id)).toHaveLength(101);
  });

  it("pages 1001 inventory claims without suppressing proposed or unlinked inventory", async () => {
    const workspace_id = await workspace();
    await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    for (let n = 0; n < 1001; n++) {
      await insertClaim({ workspace_id, claim_type: "tactic", statement: `Inventory ${n}`,
        status: n === 1000 ? "proposed" : "ongoing" });
    }
    for (const metadata of [{ retired: true }, { origin: "ideation" }, { excluded: true }]) {
      await insertClaim({ workspace_id, claim_type: "tactic", statement: "Excluded", metadata });
    }
    const seen = [];
    let cursor: string | null = null;
    do {
      const page = await listCoveragePage({ workspace_id, cursor: cursor ?? undefined, page_size: 100 });
      expect(page.pairs.length).toBeLessThanOrEqual(100);
      expect(page.progress).toMatchObject({ eligible_total: 1001, pending: 1001, assessed: 0,
        validated: 0, assessment_complete: false, validation_complete: false, excluded_claims: 3 });
      seen.push(...page.pairs);
      cursor = page.next_cursor;
    } while (cursor);
    expect(new Set(seen.map((p) => p.id)).size).toBe(1001);
    expect(await listCoveragePairs(workspace_id)).toHaveLength(1001);
  });

  it("binds cursors to factual revisions and workspace, and requires an explicit restart", async () => {
    const workspace_id = await workspace();
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    for (let n = 0; n < 4; n++) await insertClaim({ workspace_id, claim_type: "tactic", statement: `Tactic ${n}` });
    const first = await listCoveragePage({ workspace_id, page_size: 2 });
    await persistClaimPatch({ workspace_id, claim_id: gap.id, metadata: { priority: "high" } });
    expect((await listCoveragePage({ workspace_id, cursor: first.next_cursor! })).snapshot).toBe(first.snapshot);
    await expect(listCoveragePage({ workspace_id: await workspace(), cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    await persistClaimPatch({ workspace_id, claim_id: gap.id, statement: "Changed factual gap" });
    await expect(listCoveragePage({ workspace_id, cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: "stale_snapshot" });
    expect((await listCoveragePage({ workspace_id })).snapshot).not.toBe(first.snapshot);
  });

  it("enumerates the full gap × inventory universe and retains Not relevant without creating links", async () => {
    const workspace_id = await workspace();
    const gaps = [];
    for (let n = 0; n < 2; n++) gaps.push(await insertClaim({ workspace_id, claim_type: "gap", statement: `Need ${n}` }));
    const tactics = [];
    for (const status of ["ongoing", "proposed", "unknown", "cancelled"]) {
      tactics.push(await insertClaim({ workspace_id, claim_type: "tactic", statement: `Inventory ${status}`, status, metadata: { origin: "inventory" } }));
    }
    for (const status of ["excluded", "retired", "rejected", "merged"]) {
      await insertClaim({ workspace_id, claim_type: "gap", statement: "Excluded gap", status });
    }
    await insertClaim({ workspace_id, claim_type: "tactic", statement: "AI idea", metadata: { origin: "ideated" } });
    const identity = { workspace_id, gap_id: gaps[0].id, tactic_id: tactics[0].id };
    await upsertCoverageDecision({ ...identity, ...(await coveragePairRevisions(identity)), overall: "not_relevant",
      rationale: "Wrong indication", actor: { name: "Reviewer", function: "medical_affairs" } });
    const page = await listCoveragePage({ workspace_id, page_size: 3 });
    expect(page.progress).toMatchObject({ eligible_total: 8, pending: 7, assessed: 1, validated: 1, excluded_claims: 5 });
    const all = await listCoveragePairs(workspace_id);
    expect(all).toHaveLength(8);
    expect(all.filter((p) => p.overall === "not_relevant")).toHaveLength(1);
    expect((await getClaim(workspace_id, tactics[0].id))!.metadata).not.toHaveProperty("gap_ids");
    expect(page.progress.exclusions.map((c) => c.reason).sort()).toEqual(["excluded", "ideated", "merged", "rejected", "retired"]);
  });

  it("round trips Limited, protects human decisions and rejects stale writes before mutation", async () => {
    const workspace_id = await workspace();
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory" });
    const pair = { workspace_id, gap_id: gap.id, tactic_id: tactic.id };
    const expected = await coveragePairRevisions(pair);
    await upsertCoverageDecision({ ...pair, ...expected, overall: "limited", rationale: "Small overlap",
      actor: { name: "Reviewer", function: "medical_affairs" }, evidence: [] });
    expect((await listCoveragePairs(workspace_id))[0]).toMatchObject({ overall: "limited", validated: true, freshness: "current" });
    await saveCoverageAssessment({ ...pair, ...expected, overall: "full", rationale: "Model suggestion", run_id: "model-1", evidence: [] });
    expect((await listCoveragePairs(workspace_id))[0].overall).toBe("limited");
    await persistClaimPatch({ workspace_id, claim_id: tactic.id, statement: "Changed inventory" });
    await expect(upsertCoverageDecision({ ...pair, ...expected, overall: "full", rationale: "Stale decision",
      actor: { name: "Reviewer", function: "medical_affairs" } })).rejects.toMatchObject({ code: "stale_revision" });
    const current = await listCoveragePage({ workspace_id });
    expect(current.pairs[0]).toMatchObject({ overall: "limited", validated: false, freshness: "stale", protected: true });
    expect(current.progress).toMatchObject({ pending: 1, stale: 1, assessed: 0, validated: 0 });
  });

  it("refuses source identities from another workspace even when the claim has no quote spans", async () => {
    const workspace_id = await workspace();
    const foreign_workspace_id = await workspace();
    const foreign = await getWorkspace(foreign_workspace_id);
    const source = await insertSourceFile({ workspace_id: foreign_workspace_id, org_id: foreign!.org_id,
      filename: "foreign.txt", mime: "text/plain", checksum: crypto.randomUUID() });
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence", source_file_id: source.id });
    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory" });
    const identity = { workspace_id, gap_id: gap.id, tactic_id: tactic.id };
    await expect(upsertCoverageDecision({ ...identity, ...(await coveragePairRevisions(identity)), overall: "full",
      rationale: "Unverified source", actor: { name: "Reviewer", function: "medical_affairs" } }))
      .rejects.toMatchObject({ code: "invalid_evidence" });
    expect(await listCoverageJoins(workspace_id)).toEqual([]);
  });

  it("uses one atomic pair for concurrent suggestions and counts assessment separately from validation", async () => {
    const workspace_id = await workspace();
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory", status: "proposed" });
    const pair = { workspace_id, gap_id: gap.id, tactic_id: tactic.id };
    const expected = await coveragePairRevisions(pair);
    await Promise.all(Array.from({ length: 6 }, (_, n) => saveCoverageAssessment({ ...pair, ...expected,
      overall: "not_relevant", rationale: "Different population", run_id: `model-${n}`, evidence: [] })));
    expect(await listCoverageJoins(workspace_id)).toHaveLength(1);
    const page = await listCoveragePage({ workspace_id });
    expect(page.pairs[0]).toMatchObject({ overall: "not_relevant", validated: false });
    expect(page.progress).toMatchObject({ eligible_total: 1, pending: 0, assessed: 1, validated: 0,
      assessment_complete: true, validation_complete: false });
    await rejectCoveragePair({ ...pair, ...expected, rationale: "Wrong pair", actor: { name: "Reviewer", function: "medical_affairs" } });
    await saveCoverageAssessment({ ...pair, ...expected, overall: "full", rationale: "Model rerun", run_id: "rerun", evidence: [] });
    expect((await listCoveragePage({ workspace_id })).pairs[0]).toMatchObject({ overall: "pending", evidence: [],
      assessment_state: "rejected", validated: false, protected: true });
    expect(accuracyTransactionActive()).toBe(false);
  });

  it("keeps omitted and failed assessments visible and resumes only pending or failed work", async () => {
    const workspace_id = await workspace();
    await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    for (let n = 0; n < 4; n++) await insertClaim({ workspace_id, claim_type: "tactic", statement: `Inventory ${n}` });
    const calls: string[] = [];
    const first = await assessCoveragePage({ workspace_id, assess: async (pair) => {
      expect(accuracyTransactionActive()).toBe(false);
      calls.push(pair.tactic.statement);
      if (pair.tactic.statement === "Inventory 1") return undefined;
      if (pair.tactic.statement === "Inventory 2") throw new Error("Provider unavailable");
      return { overall: "limited", rationale: "Small overlap", evidence: [], run_id: "fixture-model" };
    } });
    expect(first.progress).toMatchObject({ eligible_total: 4, assessed: 2, pending: 2, failed: 2, validated: 0 });
    expect(first.pairs.filter((p) => p.assessment_state === "failed").every((p) => p.overall === "pending")).toBe(true);
    calls.length = 0;
    const second = await assessCoveragePage({ workspace_id, assess: async (pair) => {
      calls.push(pair.tactic.statement);
      return { overall: "not_relevant", rationale: "No overlap", evidence: [], run_id: "fixture-retry" };
    } });
    expect(calls.sort()).toEqual(["Inventory 1", "Inventory 2"]);
    expect(second.progress).toMatchObject({ assessed: 4, pending: 0, failed: 0, assessment_complete: true, validation_complete: false });
    await expect(withAccuracyTransaction(() => assessCoveragePage({ workspace_id, assess: async () => { throw new Error("must not run"); } })))
      .rejects.toThrow(/outside.*transaction/i);
  });

  it("refuses publishing a model answer when the universe changed during inference", async () => {
    const workspace_id = await workspace();
    await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory" });
    await expect(assessCoveragePage({ workspace_id, assess: async () => {
      await insertClaim({ workspace_id, claim_type: "gap", statement: "Another gap" });
      return { overall: "full", rationale: "Changed snapshot answer", evidence: [], run_id: "fixture-stale" };
    } })).rejects.toMatchObject({ code: "stale_snapshot" });
    expect(await listCoverageJoins(workspace_id)).toEqual([]);
  });

  it("returns a stale snapshot restart when eligibility changes during inference", async () => {
    const workspace_id = await workspace();
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory" });
    await expect(assessCoveragePage({ workspace_id, assess: async () => {
      await persistClaimPatch({ workspace_id, claim_id: gap.id, status: "excluded" });
      return { overall: "full", rationale: "Changed eligibility", evidence: [], run_id: "fixture-stale" };
    } })).rejects.toMatchObject({ code: "stale_snapshot" });
    expect(await listCoverageJoins(workspace_id)).toEqual([]);
  });

  it.each([new AiDisabledError("Coverage"), new AccuracyPausedError([])])(
    "propagates %s without treating a progression guard as model failure", async (error) => {
      const workspace_id = await workspace();
      await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
      await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory" });
      await expect(assessCoveragePage({ workspace_id, assess: async () => { throw error; } })).rejects.toBe(error);
      expect(await listCoverageJoins(workspace_id)).toEqual([]);
    },
  );

  it("coordinates inventory insertion and factual edits with the coverage publication lock", async () => {
    const workspace_id = await workspace();
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need evidence" });
    await insertClaim({ workspace_id, claim_type: "tactic", statement: "Inventory" });
    const initial = await listCoveragePage({ workspace_id });
    let start!: () => void;
    const gate = new Promise<void>((resolve) => { start = resolve; });
    // Start in separate asynchronous request contexts, outside the held transaction.
    const changes = [
      (async () => { await gate; return insertClaim({ workspace_id, claim_type: "tactic", statement: "New inventory" }); })(),
      (async () => { await gate; return persistClaimPatch({ workspace_id, claim_id: gap.id, statement: "Changed gap" }); })(),
    ];
    try {
      await withAccuracyWorkspaceMutation(workspace_id, async () => {
        start();
        expect(await Promise.race([Promise.all(changes).then(() => "published"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 80))])).toBe("waiting");
        expect((await listCoveragePage({ workspace_id })).snapshot).toBe(initial.snapshot);
      });
    } finally { start(); await Promise.allSettled(changes); }
    expect((await listCoveragePage({ workspace_id })).snapshot).not.toBe(initial.snapshot);
  });

  it("reconciles legacy duplicates deterministically without losing human history", async () => {
    const workspace_id = await workspace();
    await withAccuracyTransaction(async () => {
      await accuracyDb().execute(sql`CREATE TEMP TABLE accuracy_coverage_joins
        (LIKE public.accuracy_coverage_joins INCLUDING DEFAULTS) ON COMMIT DROP`);
      await accuracyDb().execute(sql`INSERT INTO accuracy_coverage_joins
        (id, workspace_id, gap_id, tactic_id, overall, dimensions, validated, rationale) VALUES
        ('z-model', ${workspace_id}, 'gap', 'tactic', 'none', '{}', false, 'Model unrelated'),
        ('a-human', ${workspace_id}, 'gap', 'tactic', 'covers', '{}', true, 'Human full'),
        ('b-human', ${workspace_id}, 'gap', 'tactic', 'partial', '{}', true, 'Human partial'),
        ('explicit-none', ${workspace_id}, 'gap', 'unrelated', 'none', '{}', true, 'Explicit unrelated'),
        ('legacy-unknown', ${workspace_id}, 'gap', 'unknown', 'unknown', '{}', true, 'Human unsure'),
        ('legacy-rejected', ${workspace_id}, 'gap', 'rejected', 'none', '{"human_rejected":true,"evidence":["old"]}', true, 'Pair rejected')`);
      await accuracyDb().execute(sql.raw(COVERAGE_PAIR_MIGRATION));
      await accuracyDb().execute(sql.raw(COVERAGE_PAIR_MIGRATION));
      const joins = await listCoverageJoins(workspace_id);
      expect(joins).toHaveLength(4);
      const survivor = joins.find((row) => row.id === "a-human")!;
      expect(survivor).toMatchObject({ overall: "full", validated: true, rationale: "Human full" });
      expect(joins.find((row) => row.id === "explicit-none")!.overall).toBe("not_relevant");
      expect(joins.find((row) => row.id === "legacy-unknown")!.overall).toBe("pending");
      expect(joins.find((row) => row.id === "legacy-rejected")).toMatchObject({ overall: "pending", validated: false,
        dimensions: { human_rejected: true, evidence: [], legacy_rejection: { overall: "none", dimensions: { evidence: ["old"] } } } });
      const history = (survivor.dimensions as { legacy_duplicates: { id: string; rationale: string }[] }).legacy_duplicates;
      expect(history.map((row) => row.rationale).sort()).toEqual(["Human full", "Human partial", "Model unrelated"]);
      await expect(accuracyDb().transaction((tx) => tx.execute(sql`INSERT INTO accuracy_coverage_joins
        (id, workspace_id, gap_id, tactic_id, overall, dimensions, validated)
        VALUES ('duplicate-after-migration', ${workspace_id}, 'gap', 'tactic', 'full', '{}', false)`)))
        .rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });
});
