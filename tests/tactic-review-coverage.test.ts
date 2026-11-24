/** Public gap and mapping actions must respect tactic review and preserve coverage history. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { db, poolSize, withWorkspaceTransaction } from "@/lib/iegp/db";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { buildMappingTableView } from "@/lib/iegp/mapping-table";
import { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import {
  assignTacticToGap,
  createGap,
  lockCoverageDimension,
  lockCoverageOverall,
  loadState,
  readState,
  recordMissedTactic,
  resetDemoSetup,
  reviewRequirementBasis,
} from "@/lib/iegp/store";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import { listEdits } from "@/modules/kernel/edit-records";

const actor = { actor_name: "Coverage reviewer", actor_function: "heor" as const };

/** Use the API authorization and transaction boundaries used by the form. */
function post(body: Record<string, string>) {
  return POST(new Request("http://localhost/api/iegp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...actor, ...body }),
  }));
}

/** Create an accepted tactic that can contribute toward coverage. */
function createTactic(name: string) {
  return recordMissedTactic({
    ...actor, name, type: "rwe_study", evidence_question: "What are the outcomes in community care?", status: "ongoing",
  });
}

/** Review decisions use the version of the tactic currently presented by the API. */
async function reviewTactic(tacticId: string, action: "lock_tactic_review" | "restore_tactic") {
  const tactic = (await loadState()).tactics.find(row => row.id === tacticId)!;
  return post({
    action, tactic_id: tacticId, expected_tactic: tacticEditVersion(tactic),
    ...(action === "restore_tactic"
      ? { rationale: "The study data are available again" }
      : { review_status: "rejected", note: "The study data are no longer available" }),
  });
}

/** Capture the same version the mapping row sends when saved. */
async function mappingVersion(gapId: string) {
  return buildMappingTableView(await loadState(), null).find(row => row.gap_id === gapId)!.relationships_version!;
}

/** Submit the parent choices and the status from the mapping row. */
async function saveRow(gapId: string, tacticIds: string[], status: "open" | "partially_addressed", expected?: string) {
  return post({
    action: "save_mapping_row", gap_id: gapId, tactic_ids: tacticIds.join(","), mapping_status: status,
    expected_relationship: expected ?? await mappingVersion(gapId), rationale: "Reviewed the available parent tactics",
  });
}

beforeAll(() => {
  // The overlap test needs one connection per action and one to observe the row lock.
  if (poolSize("workspace") < 3) vi.stubEnv("DATABASE_POOL_MAX", "3");
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => resetDemoSetup());

describe("gap actions after a tactic review", () => {
  it("rejects a rejected tactic when creating an Addressed gap", async () => {
    const tacticId = await createTactic("Unavailable community outcomes study");
    const rejected = await reviewTactic(tacticId, "lock_tactic_review");
    expect(rejected.status, await rejected.text()).toBe(200);
    const before = await readState();

    const result = await post({
      action: "create_addressed_gap", tactic_id: tacticId, domain: "comparative_effectiveness",
      statement: "Community care outcomes have full evidence.", note: "Add the conclusion for this study",
    });

    expect(result.status, await result.text()).toBe(400);
    const after = await readState();
    expect(after.gaps).toEqual(before.gaps);
    expect(after.coverages).toEqual(before.coverages);
    expect(after.audit).toEqual(before.audit);
  });

  it("keeps the unavailable historical link while removing a deselected accepted parent", async () => {
    const gapId = await createGap({ ...actor, statement: "More evidence is needed on outcomes in community care." });
    const unavailableId = await createTactic("Unavailable study");
    const availableId = await createTactic("Available study");
    const saved = await saveRow(gapId, [unavailableId, availableId], "partially_addressed");
    expect(saved.status, await saved.text()).toBe(200);
    const rejected = await reviewTactic(unavailableId, "lock_tactic_review");
    expect(rejected.status, await rejected.text()).toBe(200);
    const before = await readState();

    const result = await saveRow(gapId, [], "open");

    expect(result.status, await result.text()).toBe(200);
    const after = await readState();
    const historicalCoverage = before.coverages.find(row => row.gap_id === gapId && row.tactic_id === unavailableId);
    const historicalDecision = before.mapping_suggestions.find(row => row.gap_id === gapId && row.tactic_id === unavailableId);
    expect(after.coverages.filter(row => row.gap_id === gapId)).toEqual([historicalCoverage]);
    expect(after.mapping_suggestions.find(row => row.gap_id === gapId && row.tactic_id === unavailableId)).toEqual(historicalDecision);
    expect(after.mapping_suggestions.find(row => row.gap_id === gapId && row.tactic_id === availableId)).toMatchObject({ status: "rejected" });
  });

  it("rejects a mapping row submitted from before a mapped parent's rejection", async () => {
    const gapId = await createGap({ ...actor, statement: "More evidence is needed on outcomes in community care." });
    const tacticId = await createTactic("Previously available study");
    const saved = await saveRow(gapId, [tacticId], "partially_addressed");
    expect(saved.status, await saved.text()).toBe(200);
    const opened = await mappingVersion(gapId);
    const rejected = await reviewTactic(tacticId, "lock_tactic_review");
    expect(rejected.status, await rejected.text()).toBe(200);
    const before = await readState();

    const result = await saveRow(gapId, [tacticId], "open", opened);

    expect(result.status, await result.text()).toBe(400);
    const after = await readState();
    expect(after.coverages).toEqual(before.coverages);
    expect(after.mapping_suggestions).toEqual(before.mapping_suggestions);
    expect(after.audit).toEqual(before.audit);
  });

  it("uses the restored gap computation when an override waits for tactic restoration", async () => {
    const gapId = await createGap({ ...actor, statement: "What are the outcomes for the community care population?" });
    const tacticId = await createTactic("Community care outcomes study");
    await reviewRequirementBasis({
      ...actor, gap_id: gapId, expected_version: getRequirementBasisReview(await loadState(), gapId).version,
      dimensions: Object.fromEntries(COVERAGE_DIMENSIONS.map(dim => [dim, {
        applicability: dim === "population" ? "required" : "not_applicable",
        requirement: dim === "population" ? "Community care population" : "",
        rationale: "This fixture requires only a population match", resolution: "Limit the question to the community care population",
      }])), rationale: "Reviewed the population requirement",
    });
    const coverageId = await assignTacticToGap({
      ...actor, gap_id: gapId, tactic_id: tacticId, coverage: "partial", human: true, note: "Community outcomes study",
    });
    await lockCoverageDimension({ ...actor, coverage_id: coverageId, dimension: "population", value: "yes", rationale: "The population matches" });
    await lockCoverageOverall({ ...actor, coverage_id: coverageId, overall: "full", rationale: "The study meets the reviewed requirement" });
    const rejected = await reviewTactic(tacticId, "lock_tactic_review");
    expect(rejected.status, await rejected.text()).toBe(200);
    expect((await readState()).gaps.find(row => row.id === gapId)).toMatchObject({ computed_status: "validated_open" });

    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const restoring = withWorkspaceTransaction(async () => {
      const pid = Number((await db().execute(sql`select pg_backend_pid() as pid`))[0].pid);
      const restored = await reviewTactic(tacticId, "restore_tactic");
      expect(restored.status, await restored.text()).toBe(200);
      expect((await readState()).gaps.find(row => row.id === gapId)).toMatchObject({ computed_status: "validated_addressed" });
      ready.resolve(pid);
      await release.promise;
    });
    const restorerPid = await Promise.race([ready.promise, restoring.then(() => { throw new Error("Restore released its locks before the override"); })]);
    const reason = "I confirm that the available evidence addresses the gap";
    const overriding = post({ action: "override_gap_status", gap_id: gapId, status: "validated_addressed", reason });
    try {
      await vi.waitFor(async () => {
        const waiting = await db().execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and ${restorerPid} = any(pg_blocking_pids(pid))`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 5000, interval: 20 });
    } finally {
      release.resolve();
      await Promise.all([restoring, overriding]);
    }

    const result = await overriding;
    expect(result.status, await result.text()).toBe(200);
    expect((await readState()).gaps.find(row => row.id === gapId)).toMatchObject({
      status: "validated_addressed", computed_status: "validated_addressed", status_override: { reason, stale: false },
    });
    expect((await listEdits({ entity_id: gapId })).find(row => row.action === "override")).toMatchObject({
      before: "validated_addressed", after: "validated_addressed (override)", rationale: reason,
    });
  });
});
