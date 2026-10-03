import { describe, expect, it } from "vitest";
import type { AssemblyCheckReport } from "@/accuracy/domain/assembly";
import {
  AssemblyReviewError,
  assemblyCheckFingerprint,
  evaluateAssemblyReviewRequest,
  withAssemblyExperiment,
  withAssemblyPreparation,
  assemblyExecutionScope,
} from "@/accuracy/domain/assembly-review";

const passedChecks = (findings: AssemblyCheckReport["findings"] = []): AssemblyCheckReport => ({
  checker_version: "assembly-domain-v1",
  status: findings.some((finding) => finding.severity === "blocking") ? "blocked" : "passed",
  findings,
});

describe("assembly review domain policy", () => {
  it("permits only signed contributor or medical affairs reviewers", () => {
    expect(() => evaluateAssemblyReviewRequest({
      decision: "approve",
      rationale: "Approved after exact review.",
      advisory_overrides: [],
      reviewer: { subject: "user-1", provider: "test", actor: { name: "A Reviewer", function: "medical_affairs" }, role: "viewer" },
      checks: passedChecks(),
    })).toThrowError(AssemblyReviewError);

    expect(evaluateAssemblyReviewRequest({
      decision: "reject",
      rationale: "Needs a revised proposal.",
      advisory_overrides: [],
      reviewer: { subject: "user-2", provider: "test", actor: { name: "B Reviewer", function: "heor" }, role: "contributor" },
      checks: passedChecks(),
    })).toMatchObject({
      decision: "reject",
      rationale: "Needs a revised proposal.",
      reviewer_role: "contributor",
    });
  });

  it("requires nonblank rationale and explicit advisory override reasons", () => {
    const checks = passedChecks([
      { code: "coverage_stub_advisory", severity: "advisory", item_version_ids: ["gap-v", "tac-v"], message: "Stub." },
    ]);
    const reviewer = { subject: "user-1", provider: "test", actor: { name: "A Reviewer", function: "medical_affairs" as const }, role: "medical_affairs" as const };

    expect(() => evaluateAssemblyReviewRequest({
      decision: "approve",
      rationale: "   ",
      advisory_overrides: [{ code: "coverage_stub_advisory", item_version_ids: ["gap-v", "tac-v"], reason: "Accepted in test." }],
      reviewer,
      checks,
    })).toThrowError(AssemblyReviewError);

    expect(() => evaluateAssemblyReviewRequest({
      decision: "approve",
      rationale: "Approved with advisory.",
      advisory_overrides: [{ code: "coverage_stub_advisory", item_version_ids: ["gap-v", "tac-v"], reason: "   " }],
      reviewer,
      checks,
    })).toThrowError(AssemblyReviewError);

    expect(evaluateAssemblyReviewRequest({
      decision: "approve",
      rationale: "Approved with advisory.",
      advisory_overrides: [{ code: "coverage_stub_advisory", item_version_ids: ["gap-v", "tac-v"], reason: "Accepted in test." }],
      reviewer,
      checks,
    }).advisory_overrides).toEqual([
      { code: "coverage_stub_advisory", item_version_ids: ["gap-v", "tac-v"], reason: "Accepted in test." },
    ]);
  });

  it("never permits approval of blocking findings", () => {
    expect(() => evaluateAssemblyReviewRequest({
      decision: "approve",
      rationale: "Looks fine.",
      advisory_overrides: [{ code: "linking_incomplete", item_version_ids: [], reason: "Override requested." }],
      reviewer: { subject: "user-1", provider: "test", actor: { name: "A Reviewer", function: "medical_affairs" }, role: "medical_affairs" },
      checks: passedChecks([{ code: "linking_incomplete", severity: "blocking", item_version_ids: [], message: "Incomplete." }]),
    })).toThrowError(AssemblyReviewError);
  });

  it("fingerprints the full check report and exposes only trusted async scopes", async () => {
    const checks = passedChecks([{ code: "coverage_stub_advisory", severity: "advisory", item_version_ids: [], message: "Stub." }]);
    expect(assemblyCheckFingerprint(checks)).not.toBe(assemblyCheckFingerprint({
      ...checks,
      findings: [{ ...checks.findings[0]!, message: "Changed." }],
    }));

    expect(assemblyExecutionScope()).toEqual({ kind: "production" });
    await withAssemblyPreparation(async () => {
      expect(assemblyExecutionScope()).toEqual({ kind: "preparation" });
      await withAssemblyExperiment(async () => {
        expect(assemblyExecutionScope()).toEqual({ kind: "experiment" });
      });
      expect(assemblyExecutionScope()).toEqual({ kind: "preparation" });
    });
    expect(assemblyExecutionScope()).toEqual({ kind: "production" });
  });
});
