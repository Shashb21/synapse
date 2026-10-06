/** Real Postgres coverage for source-scoped retained result history. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { createExperiment, finishExperiment, recordExperimentCall } from "@/accuracy/experiments/records";
import { readExperimentResults } from "@/accuracy/experiments/results";
import { PASS_COMPARISON_EVALUATOR_VERSION } from "@/accuracy/eval/pass-comparison";
import { newId } from "@/modules/kernel/ids";
import { accuracyDb } from "@/accuracy/store/db";
import * as tables from "@/accuracy/store/schema";
import { eq } from "drizzle-orm";
import { EXPERIMENT_EVALUATOR_VERSION } from "@/accuracy/eval/experiment-gold";
import * as experimentGold from "@/accuracy/eval/experiment-gold";
import { getReferencePack } from "@/accuracy/eval/reference-gold";
import { MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT } from "@/accuracy/experiments/mixed-types";

const workspaces: string[] = [];
const mixedIds: string[] = [];
const pack_id = "beone-bgb-58067-prmt5i";

async function fixture() {
  const org_id = await createOrganization(newId("results-org"));
  const source_workspace_id = await createWorkspace({ org_id, name: "Source", slug: newId("results-source") });
  const workspace_id = await createWorkspace({ org_id, name: "Copy", slug: newId("results-copy") });
  workspaces.push(workspace_id, source_workspace_id);
  return { org_id, source_workspace_id, workspace_id };
}

async function attempt(scope: Awaited<ReturnType<typeof fixture>>, condition: Record<string, unknown>, status?: "completed" | "failed") {
  const row = await createExperiment({ ...scope, pack_id, source_fingerprint: "source-fingerprint", baseline_fingerprint: "baseline-fingerprint",
    baseline_snapshot: { sources: [{ id: "original-document", checksum: "unchanged" }] }, condition });
  if (status) await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: row.id, status });
  return row;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of mixedIds.splice(0)) await accuracyDb().delete(tables.accuracyMixedComparisons).where(eq(tables.accuracyMixedComparisons.id, id));
  for (const id of workspaces.splice(0)) await deleteWorkspace(id);
});

async function passPair(scope: Awaited<ReturnType<typeof fixture>>, id: string) {
  const condition = (critic_revision_passes: number) => ({ comparison_id: id,
    comparison_evaluator_version: PASS_COMPARISON_EVALUATOR_VERSION,
    original_request_identity: { source_workspace_id: scope.source_workspace_id },
    original_request_fingerprint: "same-request", critic_revision_passes });
  const baseline = await attempt(scope, condition(1), "completed");
  const candidate = await attempt(scope, condition(2), "completed");
  return { baseline, candidate };
}

async function withLocalGold<T>(gaps: unknown, tactics: unknown, action: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "results-gold-"));
  const goldDir = join(dir, "reference", pack_id, getReferencePack(pack_id)!.gold);
  mkdirSync(goldDir, { recursive: true });
  if (gaps !== undefined) writeFileSync(join(goldDir, "gaps.json"), JSON.stringify(gaps));
  if (tactics !== undefined) writeFileSync(join(goldDir, "tactics.json"), JSON.stringify(tactics));
  try {
    process.chdir(dir);
    return await action();
  } finally {
    process.chdir(prior);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("retained experiment results store", () => {
  it("retains independent pass cohorts, a failed candidate, running standalone raw evidence and source scope", async () => {
    // Arrange: two separately retained baseline/candidate cohorts and a standalone attempt.
    const source = await fixture();
    const foreign = await fixture();
    const pass = (comparison_id: string, critic_revision_passes: number) => ({ comparison_id,
      comparison_evaluator_version: PASS_COMPARISON_EVALUATOR_VERSION,
      original_request_identity: { mode: "single_call", source_workspace_id: source.source_workspace_id },
      original_request_fingerprint: "request-fingerprint", critic_revision_passes });
    const firstBaseline = await attempt(source, pass("cohort-1", 1), "completed");
    const firstCandidate = await attempt(source, pass("cohort-1", 2), "failed");
    const secondBaseline = await attempt(source, pass("cohort-2", 1), "completed");
    const secondCandidate = await attempt(source, pass("cohort-2", 2), "completed");
    const standalone = await attempt(source, { label: "standalone" });
    await recordExperimentCall({ workspace_id: source.workspace_id, experiment_id: standalone.id, call_id: "standalone-call",
      call_kind: "need_extract", version_index: 0, input: { raw: "preserve" }, output: { gaps: [] },
      module_version: "test-module", route: { model: "local" } });
    const foreignAttempt = await attempt(foreign, { label: "foreign" }, "completed");
    const before = await accuracyDb().select({ id: tables.accuracyExperiments.id }).from(tables.accuracyExperiments)
      .where(eq(tables.accuracyExperiments.source_workspace_id, source.source_workspace_id));

    // Act: read only from the original source workspace.
    const report = await readExperimentResults({ source_workspace_id: source.source_workspace_id });

    // Assert: no cohort is collapsed, even when a candidate failed.
    expect(report.schema_version).toBe("experiment-results-v1");
    expect(report.entries.map(entry => entry.id)).toEqual(expect.arrayContaining([
      "pass:cohort-1:2", "pass:cohort-2:2", `experiment:${standalone.id}`,
    ]));
    expect(report.entries.filter(entry => entry.kind === "pass_candidate")).toHaveLength(2);
    expect(report.entries.map(entry => entry.id)).toEqual([...report.entries]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .map(entry => entry.id));
    expect(report.entries.flatMap(entry => entry.experiment_ids)).not.toContain(foreignAttempt.id);
    expect(report.entries.flatMap(entry => entry.experiment_ids)).toEqual(expect.arrayContaining([
      firstBaseline.id, firstCandidate.id, secondBaseline.id, secondCandidate.id, standalone.id,
    ]));
    expect(report.entries.find(entry => entry.id === `experiment:${standalone.id}`)?.evidence.experiments[0].calls[0].input)
      .toEqual({ raw: "preserve" });
    expect(report.entries.find(entry => entry.id === "pass:cohort-1:2")?.attribution.label).toBe("Descriptive");
    expect((await readExperimentResults({ source_workspace_id: foreign.source_workspace_id })).entries[0].experiment_ids)
      .toContain(foreignAttempt.id);
    const after = await accuracyDb().select({ id: tables.accuracyExperiments.id }).from(tables.accuracyExperiments)
      .where(eq(tables.accuracyExperiments.source_workspace_id, source.source_workspace_id));
    expect(after).toEqual(before);
  });

  it("keeps a baseline-only partial cohort and a running mixed header without child attempts", async () => {
    const scope = await fixture();
    const baseline = await attempt(scope, { comparison_id: "partial-cohort", comparison_evaluator_version: PASS_COMPARISON_EVALUATOR_VERSION,
      original_request_identity: { source_workspace_id: scope.source_workspace_id }, original_request_fingerprint: "request",
      critic_revision_passes: 1 });
    const mixedId = newId("mixed-header");
    mixedIds.push(mixedId);
    await accuracyDb().insert(tables.accuracyMixedComparisons).values({ id: mixedId,
      source_workspace_id: scope.source_workspace_id, source_org_id: scope.org_id,
      request: { source_workspace_id: scope.source_workspace_id, source_file_ids: ["original-document"], pack_id,
        mixed: { assembly_id: "mixed-assembly", fingerprint: "mixed-fingerprint" },
        baseline: { assembly_id: "baseline-assembly", fingerprint: "baseline-fingerprint" },
        actor: { name: "fixture", function: "medical_affairs" } } as never,
      original_assemblies: { mixed: { fingerprint: "mixed-fingerprint" }, baseline: { fingerprint: "baseline-fingerprint" } } as never,
      pack_fingerprint: baseline.pack_fingerprint, evaluator_version: EXPERIMENT_EVALUATOR_VERSION,
      gate_policy: MIXED_GATE_POLICY, gate_policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT, created_at: baseline.created_at });

    const report = await readExperimentResults({ source_workspace_id: scope.source_workspace_id });

    expect(report.entries.find(entry => entry.id === "pass:partial-cohort:partial")?.experiment_ids).toContain(baseline.id);
    const mixed = report.entries.find(entry => entry.id === `mixed:${mixedId}`);
    expect(mixed?.kind).toBe("mixed_pair");
    expect(mixed?.attribution.label).toBe("Descriptive");
    expect(mixed?.evidence.mixed_comparison?.status).toBe("running");
    expect(mixed?.evidence.mixed_comparison?.attempts).toEqual({ mixed: null, baseline: null });
  });

  it("keeps raw evidence descriptive when a retained pack is no longer available", async () => {
    const scope = await fixture();
    const row = await attempt(scope, { label: "old pack" }, "completed");
    await accuracyDb().update(tables.accuracyExperiments).set({ pack_id: "retired-pack" })
      .where(eq(tables.accuracyExperiments.id, row.id));

    const report = await readExperimentResults({ source_workspace_id: scope.source_workspace_id });

    expect(report.entries[0].attribution.label).toBe("Descriptive");
    expect(report.entries[0].evidence.experiments[0]).toMatchObject({ id: row.id, pack_id: "retired-pack" });
  });

  it.each([
    ["missing gaps object", { source_pack_id: pack_id, source_filename: "fixture" }, { source_pack_id: pack_id, source_filename: "fixture", tactics: [] }],
    ["numeric must-find IDs", { source_pack_id: pack_id, source_filename: "fixture", gaps: [], must_find_gap_ids: 42 }, { source_pack_id: pack_id, source_filename: "fixture", tactics: [] }],
  ])("keeps pass history descriptive for parseable malformed gold: %s", async (_label, gaps, tactics) => {
    const scope = await fixture();
    await withLocalGold(gaps, tactics, async () => {
      const { baseline, candidate } = await passPair(scope, newId("malformed-cohort"));
      const report = await readExperimentResults({ source_workspace_id: scope.source_workspace_id });
      const entry = report.entries.find(row => row.experiment_ids.includes(candidate.id));
      expect(entry?.kind).toBe("pass_candidate");
      expect(entry?.attribution.label).toBe("Descriptive");
      expect(entry?.attribution.reasons.join(" ")).toMatch(/gold|pack|reference/i);
      expect(entry?.evidence.experiments.map(row => row.id)).toEqual(expect.arrayContaining([baseline.id, candidate.id]));
      expect(entry?.evidence.experiments[0].baseline_snapshot).toEqual({ sources: [{ id: "original-document", checksum: "unchanged" }] });
    });
  });

  it("treats ENOENT as unavailable but propagates an unexpected coded read fault", async () => {
    const scope = await fixture();
    const pair = await passPair(scope, newId("unavailable-cohort"));
    await withLocalGold(undefined, undefined, async () => {
      const report = await readExperimentResults({ source_workspace_id: scope.source_workspace_id });
      expect(report.entries.find(row => row.experiment_ids.includes(pair.candidate.id))?.attribution.label).toBe("Descriptive");
    });
    const internal = Object.assign(new Error("internal coded failure"), { code: "EIO" });
    vi.spyOn(experimentGold, "experimentPackFingerprint").mockImplementation(() => { throw internal; });
    await expect(readExperimentResults({ source_workspace_id: scope.source_workspace_id })).rejects.toBe(internal);
  });
});
