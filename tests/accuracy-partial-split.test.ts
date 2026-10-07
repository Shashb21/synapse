import { eq } from "drizzle-orm";
import { accuracyDb, withAccuracyWorkspaceMutation } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { readAccuracySplitInputs } from "@/accuracy/store/partial-split-store";
import { copyExperimentWorkspace } from "@/accuracy/experiments/copy-workspace";
import { updateClaim } from "@/accuracy/store/claim-edit";
import { type SplitProposal, type SplitSnapshot } from "@/accuracy/store/partial-split-store";
import { claimValidationFreshness, readStructuredFields } from "@/accuracy/domain/structured-fields";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyAccuracySplit, listAccuracySplitOperations, rollbackAccuracySplit } from "@/accuracy/store/partial-split-store";
import { getClaim, isActiveLedgerClaim, listClaims, insertClaim, claimMetadata } from "@/accuracy/store/claim-store";
import { listCoverageJoins, upsertCoverageDecision, coveragePairRevisions, insertCoverageJoin } from "@/accuracy/store/coverage-store";
import { deleteWorkspace } from "@/accuracy/store/tenant";
import { splitActor, splitFixture } from "./support/accuracy-split";

const workspaces: string[] = [];
afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });
async function fixture() { const f = await splitFixture(); workspaces.push(f.workspace_id); return f; }
function apply(f: Awaited<ReturnType<typeof fixture>>, operation_key = "confirmed-split") {
  return applyAccuracySplit({ workspace_id: f.workspace_id, proposal: f.proposal, operation_key, actor: splitActor, rationale: "Confirmed outcomes slice and remaining comparison" });
}
async function splitState(workspace_id: string) {
  return { claims: await listClaims(workspace_id), coverage: await listCoverageJoins(workspace_id), operations: await listAccuracySplitOperations(workspace_id) };
}
describe("confirmed Accuracy residual split", () => {
  it("persists two real children, explicit slice support, pending residual and exact reversible snapshot", async () => {
    const f = await fixture();
    const first = await apply(f);
    expect(await apply(f)).toEqual(first);
    const addressed = (await getClaim(f.workspace_id, first.addressed_gap_id))!;
    const residual = (await getClaim(f.workspace_id, first.open_residual_gap_id))!;
    expect(addressed.statement).toBe("Need outcome evidence from the chart review.");
    expect(residual.statement).toBe("Need comparative evidence against standard care.");
    expect(residual.metadata).not.toHaveProperty("priority");
    expect(residual.metadata).not.toHaveProperty("priority_validated");
    expect(isActiveLedgerClaim((await getClaim(f.workspace_id, f.parent.id))!)).toBe(false);
    const joins = await listCoverageJoins(f.workspace_id, { effective: true });
    expect(joins.filter(c => c.gap_id === addressed.id)).toEqual([expect.objectContaining({ overall: "full", validated: true, freshness: "current" })]);
    expect(joins.filter(c => c.gap_id === residual.id)).toEqual([expect.objectContaining({ overall: "pending", validated: false })]);
    expect((await listAccuracySplitOperations(f.workspace_id))[0]).toMatchObject({ id: first.operation_id, parent_gap_id: f.parent.id, state: "applied" });
    await rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: first.operation_id, actor: splitActor, rationale: "Restore the original question" });
    expect(await getClaim(f.workspace_id, f.parent.id)).toEqual(f.parent);
    expect((await listClaims(f.workspace_id)).filter(isActiveLedgerClaim).map(c => c.id).sort()).toEqual([f.parent.id, f.tactic.id].sort());
    expect((await listAccuracySplitOperations(f.workspace_id))[0].state).toBe("rolled_back");
  });
});

it("rolls every visible record back when the second child insert fails", async () => {
  const f = await fixture();
  const before = { claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id), operations: await listAccuracySplitOperations(f.workspace_id) };
  const connection = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const trigger = `split_failure_${Date.now()}`;
  try {
    await connection.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${f.workspace_id}' AND NEW.statement = 'Need comparative evidence against standard care.' THEN RAISE EXCEPTION 'injected second child failure'; END IF; RETURN NEW; END $$`);
    await connection.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON accuracy_claims FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    await expect(apply(f)).rejects.toMatchObject({ cause: expect.objectContaining({ message: "injected second child failure" }) });
    expect({ claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id), operations: await listAccuracySplitOperations(f.workspace_id) }).toEqual(before);
  } finally {
    await connection.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON accuracy_claims`);
    await connection.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`);
    await connection.end({ timeout: 5 });
  }
});

it("serializes identical concurrent retries and rejects a competing operation without orphan children", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([apply(f), apply(f)]);
  expect(a).toEqual(b);
  await expect(apply(f, "competing")).rejects.toThrow();
  expect(await listClaims(f.workspace_id)).toHaveLength(4);
  expect(await listAccuracySplitOperations(f.workspace_id)).toHaveLength(1);
});

it("copies split lineage, evidence and reversible snapshots into an isolated experiment", async () => {
  const f = await fixture(); const result = await apply(f);
  const copy = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] });
  workspaces.push(copy.workspace_id);
  const [operation] = await listAccuracySplitOperations(copy.workspace_id);
  expect(operation).toMatchObject({ workspace_id: copy.workspace_id, parent_gap_id: copy.claim_id_map[f.parent.id],
    addressed_gap_id: copy.claim_id_map[result.addressed_gap_id], open_residual_gap_id: copy.claim_id_map[result.open_residual_gap_id] });
  expect(operation.id).not.toBe(result.operation_id);
  for (const id of [f.workspace_id, f.parent.id, f.tactic.id, f.evidence[0].source_file_id, f.evidence[0].block_id]) {
    expect(JSON.stringify(operation.snapshot)).not.toContain(id);
    expect(JSON.stringify(operation.audit)).not.toContain(id);
  }
  await rollbackAccuracySplit({ workspace_id: copy.workspace_id, operation_id: operation.id, actor: splitActor, rationale: "Undo only copied split" });
  expect(claimValidationFreshness((await getClaim(copy.workspace_id, copy.claim_id_map[f.parent.id]))!)).toBe("current");
  expect((await getClaim(f.workspace_id, f.parent.id))!.status).toBe("retired");
  const deleted = await deleteWorkspace(copy.workspace_id); workspaces.splice(workspaces.indexOf(copy.workspace_id), 1);
  expect(deleted.deleted.split_operations).toBe(1);
  expect(await listAccuracySplitOperations(f.workspace_id)).toHaveLength(1);
});

it("copies revised parent decision history consistently in live coverage and reversible split snapshots", async () => {
  const f = await fixture();
  const [originalDecision] = await listCoverageJoins(f.workspace_id);
  const rationale = `Reviewed ${f.workspace_id} and ${f.evidence[0].block_id} as literal audit text`;
  await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id,
    ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id }),
    overall: "partial", evidence: [f.evidence[0].block_id], actor: splitActor, rationale });
  f.proposal = { ...f.proposal, ...(await readAccuracySplitInputs({ workspace_id: f.workspace_id, gap_id: f.parent.id })).revisions };
  await apply(f);
  const before = await splitState(f.workspace_id);
  const copy = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] });
  workspaces.push(copy.workspace_id);
  const [operation] = await listAccuracySplitOperations(copy.workspace_id);
  const live = (await listCoverageJoins(copy.workspace_id)).find(c => c.gap_id === copy.claim_id_map[f.parent.id])!;
  const saved = (operation.snapshot as SplitSnapshot).after_coverage.find(c => c.gap_id === live.gap_id)!;
  const history = { ...originalDecision, id: live.id, workspace_id: copy.workspace_id,
    gap_id: copy.claim_id_map[f.parent.id], tactic_id: copy.claim_id_map[f.tactic.id],
    dimensions: { ...Object.fromEntries(Object.entries(originalDecision.dimensions as Record<string, unknown>).filter(([key]) => key !== "decision_history")),
      evidence: [copy.block_id_map[f.evidence[0].block_id]] } };
  for (const row of [live, saved]) {
    expect(row.dimensions).toMatchObject({ decision_history: [history], actor: splitActor });
    expect(row.rationale).toBe(rationale);
  }
  expect(saved).toEqual(live);
  expect(await splitState(f.workspace_id)).toEqual(before);
  await rollbackAccuracySplit({ workspace_id: copy.workspace_id, operation_id: operation.id, actor: splitActor, rationale: "Undo copied revised split" });
  expect(await getClaim(copy.workspace_id, copy.claim_id_map[f.parent.id])).toEqual((operation.snapshot as SplitSnapshot).before_parent);
  expect(await splitState(f.workspace_id)).toEqual(before);
});

it("copies rolled-back splits with scoped retirement references, preserved stale tokens and an inverse no-op", async () => {
  const f = await fixture(); const split = await apply(f);
  await rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: split.operation_id, actor: splitActor, rationale: "Original rollback" });
  const before = await splitState(f.workspace_id);
  const copy = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] });
  workspaces.push(copy.workspace_id);
  const copied = await splitState(copy.workspace_id);
  const [operation] = copied.operations;
  expect(operation).toMatchObject({ state: "rolled_back", rolled_back_at: before.operations[0].rolled_back_at });
  expect(operation.id).not.toBe(split.operation_id);
  const snapshot = operation.snapshot as SplitSnapshot;
  for (const original of before.coverage.filter(c => c.gap_id !== f.parent.id)) {
    const live = copied.coverage.find(c => c.gap_id === copy.claim_id_map[original.gap_id])!;
    const saved = snapshot.after_coverage.find(c => c.id === live.id)!;
    expect(live).toMatchObject({ workspace_id: copy.workspace_id, tactic_id: copy.claim_id_map[f.tactic.id], overall: "pending", validated: false,
      dimensions: { retired_by_rollback: operation.id, validation_stale: true,
        gap_revision: (original.dimensions as Record<string, unknown>).gap_revision,
        tactic_revision: (original.dimensions as Record<string, unknown>).tactic_revision,
        evidence: (original.dimensions as { evidence: string[] }).evidence.map(id => copy.block_id_map[id]) } });
    expect(saved).toMatchObject({ workspace_id: copy.workspace_id, gap_id: live.gap_id, tactic_id: live.tactic_id,
      dimensions: { evidence: (original.dimensions as { evidence: string[] }).evidence.map(id => copy.block_id_map[id]) } });
    expect(saved.dimensions).not.toHaveProperty("retired_by_rollback");
    expect(live.dimensions).not.toHaveProperty("copied_from_revisions");
  }
  const effective = await listCoverageJoins(copy.workspace_id, { effective: true });
  expect(effective.filter(c => c.gap_id !== operation.parent_gap_id).every(c => c.overall === "pending" && !c.validated && c.freshness !== "current")).toBe(true);
  await rollbackAccuracySplit({ workspace_id: copy.workspace_id, operation_id: operation.id, actor: splitActor, rationale: "Replay copied inverse" });
  expect(await splitState(copy.workspace_id)).toEqual(copied);
  expect(await splitState(f.workspace_id)).toEqual(before);
});

it("retains later coverage decisions and their history when copying, so copied inverse stays blocked", async () => {
  const f = await fixture(); const split = await apply(f);
  const pending = (await listCoverageJoins(f.workspace_id)).find(c => c.gap_id === split.open_residual_gap_id)!;
  await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: split.open_residual_gap_id, tactic_id: f.tactic.id,
    ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: split.open_residual_gap_id, tactic_id: f.tactic.id }),
    overall: "limited", evidence: [f.evidence[0].block_id], actor: splitActor, rationale: "Later human decision must survive copy" });
  const before = await splitState(f.workspace_id);
  const copy = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] });
  workspaces.push(copy.workspace_id);
  const copied = await splitState(copy.workspace_id); const [operation] = copied.operations;
  const live = copied.coverage.find(c => c.gap_id === operation.open_residual_gap_id)!;
  const saved = (operation.snapshot as SplitSnapshot).after_coverage.find(c => c.id === live.id)!;
  expect(live).toMatchObject({ overall: "limited", validated: true, rationale: "Later human decision must survive copy" });
  expect(live.dimensions).toMatchObject({ decision_history: [expect.objectContaining({ id: live.id, workspace_id: copy.workspace_id,
    gap_id: operation.open_residual_gap_id, tactic_id: copy.claim_id_map[f.tactic.id], overall: "pending", validated: false,
    dimensions: Object.fromEntries(Object.entries(pending.dimensions as Record<string, unknown>).filter(([key]) => key !== "decision_history")) })] });
  expect(saved).toMatchObject({ overall: "pending", validated: false });
  expect(saved.dimensions).toMatchObject({ decision_history: [] });
  await expect(rollbackAccuracySplit({ workspace_id: copy.workspace_id, operation_id: operation.id, actor: splitActor, rationale: "Must retain the later decision" })).rejects.toMatchObject({ code: "rollback_blocked" });
  expect(await splitState(copy.workspace_id)).toEqual(copied);
  expect(await splitState(f.workspace_id)).toEqual(before);
});

it.each([
  ["unconfirmed", (p: SplitProposal) => ({ ...p, confirmed: false })],
  ["same residual", (p: SplitProposal) => ({ ...p, open_statement: p.addressed_statement })],
  ["parent restatement", (p: SplitProposal) => ({ ...p, open_statement: "Need outcomes and comparative evidence." })],
  ["empty residual", (p: SplitProposal) => ({ ...p, open_statement: "   " })],
  ["unsupported quote", (p: SplitProposal) => ({ ...p, addressed_evidence: [{ ...p.addressed_evidence[0], quote: "Invented quote" }] })],
  ["unmapped tactic", (p: SplitProposal) => ({ ...p, addressed_tactic_ids: ["unmapped"] })],
  ["stale revision", (p: SplitProposal) => ({ ...p, expected_parent_revision: "old" })],
  ["wrong workspace", (p: SplitProposal) => ({ ...p, workspace_id: "other" })],
] as const)("refuses %s without any visible mutation", async (_label, change) => {
  const f = await fixture(); const before = { claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id) };
  f.proposal = change(f.proposal);
  await expect(apply(f)).rejects.toThrow();
  expect({ claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id) }).toEqual(before);
  expect(await listAccuracySplitOperations(f.workspace_id)).toEqual([]);
});

it.each(["proposed", "cancelled", "unknown"])("refuses %s supporting lifecycle despite a stored Partial", async lifecycle => {
  const f = await fixture();
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.tactic.id, patch: { tactic_status: lifecycle as "proposed" | "cancelled" | "unknown" }, actor: splitActor, rationale: "Lifecycle corrected" });
  await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id,
    ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id }), overall: "partial", evidence: [f.evidence[0].block_id], actor: splitActor, rationale: "Current Partial only" });
  await expect(apply(f)).rejects.toMatchObject({ code: "ineligible_parent" });
  expect(await listClaims(f.workspace_id)).toHaveLength(2);
});

it.each(["priority", "statement", "coverage", "descendant", "parent priority"])("blocks rollback after a later %s edit and preserves every current record", async kind => {
  const f = await fixture(); const result = await apply(f);
  if (kind === "coverage") await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: result.open_residual_gap_id, tactic_id: f.tactic.id,
    ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: result.open_residual_gap_id, tactic_id: f.tactic.id }), overall: "limited", evidence: [f.evidence[0].block_id], actor: splitActor, rationale: "Later human coverage" });
  else if (kind === "descendant") await insertClaim({ workspace_id: f.workspace_id, claim_type: "gap", statement: "Further residual question", metadata: { parent_gap_id: result.open_residual_gap_id } });
  else await updateClaim({ workspace_id: f.workspace_id, claim_id: kind === "parent priority" ? f.parent.id : result.open_residual_gap_id,
    patch: kind === "statement" ? { statement: "A later refined residual question" } : { priority: "low" }, actor: splitActor, rationale: "Later human correction" });
  const before = { claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id), operations: await listAccuracySplitOperations(f.workspace_id) };
  await expect(rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Would erase a later edit" })).rejects.toMatchObject({ code: "rollback_blocked" });
  expect({ claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id), operations: await listAccuracySplitOperations(f.workspace_id) }).toEqual(before);
});

it("does not promote inherited parent context into residual direct evidence or Full", async () => {
  const f = await fixture(); f.proposal.open_evidence = [];
  const result = await apply(f); const residual = (await getClaim(f.workspace_id, result.open_residual_gap_id))!;
  expect(claimMetadata(residual).provenance).toEqual([]);
  expect(claimMetadata(residual).inherited_context).toEqual(f.evidence);
  expect(readStructuredFields(residual).description).toMatchObject({ state: "unknown", provenance: [] });
  expect((await listCoverageJoins(f.workspace_id, { effective: true })).filter(c => c.gap_id === residual.id).every(c => c.overall === "pending" && !c.validated)).toBe(true);
});

it("rejects a purported uncovered dimension that every supporting verdict explicitly closes", async () => {
  const f = await fixture();
  await withAccuracyWorkspaceMutation(f.workspace_id, async () => {
    const [join] = await listCoverageJoins(f.workspace_id);
    await accuracyDb().update(t.accuracyCoverageJoins).set({ dimensions: { ...(join.dimensions as Record<string, unknown>), comparator: { value: "yes", rationale: "Comparator fully closed" } } }).where(eq(t.accuracyCoverageJoins.id, join.id));
  });
  f.proposal = { ...f.proposal, ...(await readAccuracySplitInputs({ workspace_id: f.workspace_id, gap_id: f.parent.id })).revisions };
  await expect(apply(f)).rejects.toMatchObject({ code: "invalid_split" });
  expect(await listClaims(f.workspace_id)).toHaveLength(2);
});

it("rejects changed coverage and human inputs even while the parent remains currently Partial", async () => {
  const f = await fixture();
  await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id,
    ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id }), overall: "partial", evidence: [f.evidence[0].block_id], actor: splitActor, rationale: "Revised supporting rationale" });
  await expect(apply(f)).rejects.toMatchObject({ code: "stale_revision" });
  f.proposal = { ...f.proposal, ...(await readAccuracySplitInputs({ workspace_id: f.workspace_id, gap_id: f.parent.id })).revisions };
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.parent.id, patch: { priority: "low" }, actor: splitActor, rationale: "Different parent priority" });
  await expect(apply(f)).rejects.toMatchObject({ code: "stale_revision" });
  expect(await listClaims(f.workspace_id)).toHaveLength(2);
});

it("allows one winner for simultaneous competing operations", async () => {
  const f = await fixture(); const results = await Promise.allSettled([apply(f, "first"), apply(f, "second")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(await listClaims(f.workspace_id)).toHaveLength(4);
  expect(await listAccuracySplitOperations(f.workspace_id)).toHaveLength(1);
  f.proposal.rationale = ["Changed retry payload"];
  const winningKey = results[0].status === "fulfilled" ? "first" : "second";
  await expect(apply(f, winningKey)).rejects.toMatchObject({ code: "operation_conflict" });
});

it("keeps all applied rows intact if rollback audit persistence fails", async () => {
  const f = await fixture(); const result = await apply(f);
  const before = { claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id), operations: await listAccuracySplitOperations(f.workspace_id) };
  const connection = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const trigger = `split_rollback_failure_${Date.now()}`;
  try {
    await connection.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${result.operation_id}' AND NEW.state = 'rolled_back' THEN RAISE EXCEPTION 'injected rollback audit failure'; END IF; RETURN NEW; END $$`);
    await connection.unsafe(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON accuracy_split_operations FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    await expect(rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Atomic rollback" })).rejects.toMatchObject({ cause: expect.objectContaining({ message: "injected rollback audit failure" }) });
    expect({ claims: await listClaims(f.workspace_id), coverage: await listCoverageJoins(f.workspace_id), operations: await listAccuracySplitOperations(f.workspace_id) }).toEqual(before);
  } finally {
    await connection.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON accuracy_split_operations`);
    await connection.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`);
    await connection.end({ timeout: 5 });
  }
});

it("keeps wrong-workspace rollback and rolled-back replay isolated", async () => {
  const f = await fixture(), other = await fixture(); const result = await apply(f);
  await expect(rollbackAccuracySplit({ workspace_id: other.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Wrong workspace" })).rejects.toMatchObject({ code: "unknown_operation" });
  await rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Restore original parent" });
  await rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Same rollback retry" });
  await expect(apply(f)).rejects.toMatchObject({ code: "operation_conflict" });
  expect(await getClaim(f.workspace_id, f.parent.id)).toEqual(f.parent);
  expect(await listClaims(other.workspace_id)).toHaveLength(2);
});

it("allows a supported Partial split while an unrelated mapped pair remains unsupported and pending", async () => {
  const f = await fixture();
  const unrelated = await insertClaim({ workspace_id: f.workspace_id, claim_type: "tactic", statement: "Unresolved unrelated inventory",
    source_file_id: "missing-source", metadata: { tactic_status: "unknown", provenance: [{ source_file_id: "missing-source", block_id: "missing-block", quote: "Unknown context" }] } });
  await insertCoverageJoin({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: unrelated.id, overall: "partial", validated: true, rationale: "Untrusted historical input" });
  f.proposal = { ...f.proposal, ...(await readAccuracySplitInputs({ workspace_id: f.workspace_id, gap_id: f.parent.id })).revisions };
  const result = await apply(f);
  expect(await getClaim(f.workspace_id, result.addressed_gap_id)).not.toBeNull();
  expect((await listCoverageJoins(f.workspace_id, { effective: true })).filter(c => c.gap_id === result.open_residual_gap_id)).toEqual([expect.objectContaining({ tactic_id: f.tactic.id, overall: "pending", validated: false })]);
});

it("uses original valid pair provenance when current Partial coverage has no selected citation list", async () => {
  const f = await fixture();
  await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id,
    ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: f.parent.id, tactic_id: f.tactic.id }), overall: "partial", evidence: [], actor: splitActor, rationale: "Confirmed source-backed pair with no selected citations" });
  f.proposal = { ...f.proposal, ...(await readAccuracySplitInputs({ workspace_id: f.workspace_id, gap_id: f.parent.id })).revisions };
  const result = await apply(f);
  expect((await listCoverageJoins(f.workspace_id, { effective: true })).find(c => c.gap_id === result.addressed_gap_id)).toMatchObject({ overall: "full", validated: true, freshness: "current" });
});

import { setAccuracyPlacement, listAccuracyPlacements } from "@/accuracy/store/priority-store";
it("refuses split rollback after a real human placement validation on the residual", async () => {
  const f = await fixture(), result = await apply(f);
  await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: result.open_residual_gap_id,
    band: "defer", validate: true, actor: splitActor, rationale: "Human defers this residual this cycle" });
  const before = { claims: await listClaims(f.workspace_id), placements: await listAccuracyPlacements(f.workspace_id) };
  await expect(rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Do not overwrite later decisions" })).rejects.toMatchObject({ code: "rollback_blocked" });
  expect({ claims: await listClaims(f.workspace_id), placements: await listAccuracyPlacements(f.workspace_id) }).toEqual(before);
});

import { prioritizeModule } from "@/accuracy/modules/prioritize/module";
import { scriptedPriorityContext } from "./support/accuracy-priority";
it("permits exact split rollback after a harmless unvalidated model priority suggestion", async () => {
  const f = await fixture(), result = await apply(f), before = process.env.SYNAPSE_TEST_STUB_LLM;
  process.env.SYNAPSE_TEST_STUB_LLM = "";
  try {
    await prioritizeModule.run(prioritizeModule.inputSchema.parse({ workspace_id: f.workspace_id, gap_ids: [result.open_residual_gap_id], x_axis: "effort_cost", y_axis: "decision_impact" }), scriptedPriorityContext(f));
    expect((await listAccuracyPlacements(f.workspace_id))[0]).toMatchObject({ validated: false, human_revision: null });
    await rollbackAccuracySplit({ workspace_id: f.workspace_id, operation_id: result.operation_id, actor: splitActor, rationale: "Restore original; suggestion was not a human decision" });
    expect(await getClaim(f.workspace_id, f.parent.id)).toEqual(f.parent);
  } finally { if (before === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = before; }
});
it("copies later human priority placements and keeps split rollback blocked in both isolated workspaces", async () => {
  const f = await fixture(), result = await apply(f);
  await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: result.open_residual_gap_id, band: "defer", validate: true, actor: splitActor, rationale: "Later human residual decision" });
  const copied = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] }); workspaces.push(copied.workspace_id);
  const operation = (await listAccuracySplitOperations(copied.workspace_id))[0];
  expect((await listAccuracyPlacements(copied.workspace_id))[0]).toMatchObject({ gap_id: copied.claim_id_map[result.open_residual_gap_id], validated: true, band: "defer" });
  await expect(rollbackAccuracySplit({ workspace_id: copied.workspace_id, operation_id: operation.id, actor: splitActor, rationale: "Blocked copied inverse" })).rejects.toMatchObject({ code: "rollback_blocked" });
  expect((await listAccuracySplitOperations(f.workspace_id))[0].state).toBe("applied");
  expect((await listAccuracyPlacements(f.workspace_id))[0].band).toBe("defer");
});
