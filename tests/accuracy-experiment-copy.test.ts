import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction, withAccuracyWorkspaceMutation } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import {
  createOrganization,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
} from "@/accuracy/store/tenant";
import { insertClaim, persistClaimPatch } from "@/accuracy/store/claim-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertCoverageJoin, upsertCoverageDecision, coveragePairRevisions, listCoveragePairs, listCoverageJoins, reassignCoverageClaimId, type CoverageJoinRow } from "@/accuracy/store/coverage-store";
import { newId } from "@/modules/kernel/ids";
import { copyExperimentWorkspace } from "@/accuracy/experiments/copy-workspace";

const createdWorkspaces: string[] = [];

async function fixture() {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`copy-test-${newId("org")}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: "Source workspace",
    slug: `copy-source-${newId("slug")}`,
  });
  createdWorkspaces.push(workspace_id);
  const source_file_id = await insertSourceFile({
    workspace_id,
    org_id,
    filename: "source.txt",
    mime: "text/plain",
    checksum: "source-checksum",
    doc_role: "medical",
  }).then((row) => row.id);
  const block_id = newId("block");
  await persistParseBlocks({
    workspace_id,
    source_file_id,
    parser: "test",
    blocks: [{
      id: block_id,
      source_file_id,
      index: 0,
      kind: "prose",
      heading: "Evidence",
      text: "The source evidence supports the proposed need.",
    }],
  });
  const claim = await insertClaim({
    workspace_id,
    source_file_id,
    claim_type: "gap",
    statement: "The proposed need requires evidence.",
    metadata: {},
  });
  const tactic = await insertClaim({
    workspace_id,
    source_file_id,
    claim_type: "tactic",
    statement: "Collect the supporting evidence.",
    metadata: {},
  });
  const provenance_id = newId("prov");
  await accuracyDb().insert(t.accuracyProvenance).values({
    id: provenance_id,
    workspace_id,
    claim_id: claim.id,
    source_file_id,
    block_id,
    quote: "The source evidence supports the proposed need.",
  });
  const coverage = await insertCoverageJoin({
    workspace_id,
    gap_id: claim.id,
    tactic_id: tactic.id,
    overall: "covers",
    rationale: "The tactic addresses the need.",
  });
  return { org_id, workspace_id, source_file_id, block_id, claim, tactic, provenance_id, coverage };
}

afterEach(async () => {
  for (const workspace_id of createdWorkspaces.splice(0)) {
    if (await getWorkspace(workspace_id)) await deleteWorkspace(workspace_id);
  }
});

describe("copyExperimentWorkspace", () => {
  it("copies a parsed source with no baseline claims", async () => {
    await ensureAccuracySchema();
    const org_id = await createOrganization(`copy-empty-${newId("org")}`);
    const workspace_id = await createWorkspace({ org_id, name: "Empty baseline", slug: `copy-empty-${newId("slug")}` });
    createdWorkspaces.push(workspace_id);
    const source = await insertSourceFile({ workspace_id, org_id, filename: "empty.txt", mime: "text/plain", checksum: newId("sum") });
    await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: newId("block"), source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "No prior claims." }] });

    const copy = await copyExperimentWorkspace({ source_workspace_id: workspace_id, source_file_ids: [source.id] });
    createdWorkspaces.push(copy.workspace_id);

    expect(copy.claim_id_map).toEqual({});
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, copy.workspace_id))).toHaveLength(1);
  });

  it("copies selected baseline rows with remapped foreign keys and fingerprints", async () => {
    const source = await fixture();
    const before = {
      sources: await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, source.workspace_id)),
      blocks: await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, source.workspace_id)),
      claims: await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id)),
      provenance: await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, source.workspace_id)),
      coverage: await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, source.workspace_id)),
    };

    const copy = await copyExperimentWorkspace({
      source_workspace_id: source.workspace_id,
      source_file_ids: [source.source_file_id],
    });
    createdWorkspaces.push(copy.workspace_id);

    expect(copy.org_id).not.toBe(source.org_id);
    expect(copy.workspace_id).not.toBe(source.workspace_id);
    expect(copy.source_id_map[source.source_file_id]).toBeTruthy();
    expect(copy.block_id_map[source.block_id]).toBeTruthy();
    expect(copy.claim_id_map[source.claim.id]).toBeTruthy();
    expect(copy.claim_id_map[source.tactic.id]).toBeTruthy();
    expect(copy.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(copy.baseline_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const copiedSources = await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, copy.workspace_id));
    const copiedBlocks = await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, copy.workspace_id));
    const copiedClaims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    const copiedProvenance = await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, copy.workspace_id));
    const copiedCoverage = await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, copy.workspace_id));
    expect(copiedSources).toHaveLength(1);
    expect(copiedBlocks).toHaveLength(1);
    expect(copiedClaims).toHaveLength(2);
    expect(copiedProvenance).toHaveLength(1);
    expect(copiedCoverage).toHaveLength(1);
    expect((await listCoveragePairs(copy.workspace_id))[0]).toMatchObject({ freshness: "unknown", validated: false });
    expect((copy.baseline_snapshot as { source_files: Array<Record<string, unknown>> }).source_files[0]).toMatchObject({
      original_id: source.source_file_id,
      copied_id: copy.source_id_map[source.source_file_id],
      id: copy.source_id_map[source.source_file_id],
      workspace_id: copy.workspace_id,
      org_id: copy.org_id,
    });
    expect(copiedBlocks[0]).toMatchObject({ workspace_id: copy.workspace_id, source_file_id: copy.source_id_map[source.source_file_id], text: before.blocks[0]?.text });
    expect(copiedProvenance[0]).toMatchObject({ workspace_id: copy.workspace_id, claim_id: copy.claim_id_map[source.claim.id], source_file_id: copy.source_id_map[source.source_file_id], block_id: copy.block_id_map[source.block_id] });
    expect(copiedCoverage[0]).toMatchObject({ workspace_id: copy.workspace_id, gap_id: copy.claim_id_map[source.claim.id], tactic_id: copy.claim_id_map[source.tactic.id] });
    expect(copy.baseline_snapshot).not.toHaveProperty("gold");

    expect(await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, source.workspace_id))).toEqual(before.sources);
    expect(await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, source.workspace_id))).toEqual(before.blocks);
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual(before.claims);
    expect(await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, source.workspace_id))).toEqual(before.provenance);
    expect(await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, source.workspace_id))).toEqual(before.coverage);
  });

  it("preserves current coverage validation after trusted identity remapping without refreshing unknown legacy joins", async () => {
    const source = await fixture();
    const identity = { workspace_id: source.workspace_id, gap_id: source.claim.id, tactic_id: source.tactic.id };
    expect((await listCoveragePairs(source.workspace_id))[0]).toMatchObject({ freshness: "unknown", validated: false });
    const span = { source_file_id: source.source_file_id, block_id: source.block_id, quote: "The source evidence supports the proposed need." };
    await persistClaimPatch({ workspace_id: source.workspace_id, claim_id: source.claim.id, metadata: { provenance: [span] } });
    await upsertCoverageDecision({ ...identity, ...(await coveragePairRevisions(identity)), overall: "limited",
      rationale: "Reviewer confirmed small overlap", evidence: [source.block_id], actor: { name: "Ada", function: "medical_affairs" } });
    const original = await listCoverageJoins(source.workspace_id);
    const copy = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(copy.workspace_id);
    expect((await listCoveragePairs(copy.workspace_id))[0]).toMatchObject({ overall: "limited", freshness: "current", validated: true });
    const copied = (await listCoverageJoins(copy.workspace_id))[0];
    expect((await listCoveragePairs(copy.workspace_id))[0].evidence).toEqual([copy.block_id_map[source.block_id]]);
    expect(copied.dimensions).toMatchObject({ actor: { name: "Ada", function: "medical_affairs" } });
    expect(await listCoverageJoins(source.workspace_id)).toEqual(original);
  });

  it("copies stale merge and import histories with consistent deleted-join IDs without refreshing their decisions", async () => {
    const source = await fixture();
    const other = await insertClaim({ workspace_id: source.workspace_id, source_file_id: source.source_file_id,
      claim_type: "tactic", statement: "Alternative evidence collection" });
    const identity = { workspace_id: source.workspace_id, gap_id: source.claim.id, tactic_id: source.tactic.id };
    const actor = { name: source.block_id, function: "medical_affairs" as const };
    const rationale = `Literal ${source.workspace_id} and ${source.claim.id}`;
    await persistClaimPatch({ workspace_id: source.workspace_id, claim_id: source.claim.id,
      metadata: { provenance: [{ source_file_id: source.source_file_id, block_id: source.block_id, quote: "The source evidence supports the proposed need." }] } });
    await upsertCoverageDecision({ ...identity, ...await coveragePairRevisions(identity), overall: "limited",
      rationale, evidence: [source.block_id], actor });
    const imported = await insertCoverageJoin({ workspace_id: source.workspace_id, gap_id: source.claim.id, tactic_id: other.id,
      overall: "partial", rationale: "Retained imported decision" });
    // Whole rows retained by the existing legacy reconciliation owner, including
    // an ID no longer present in the live table. No revision token is trusted.
    const historical = { ...imported, id: newId("legacy-cov"), dimensions: { evidence: [source.block_id],
      gap_revision: "stale-gap-token", tactic_revision: "stale-tactic-token", actor,
      provenance: [{ source_file_id: source.source_file_id, block_id: source.block_id, quote: "The source evidence supports the proposed need." }] } };
    await withAccuracyWorkspaceMutation(source.workspace_id, async () => {
      await accuracyDb().update(t.accuracyCoverageJoins).set({ dimensions: { legacy_duplicates: [historical], legacy_rejection: historical } })
        .where(eq(t.accuracyCoverageJoins.id, imported.id));
    });
    await reassignCoverageClaimId({ workspace_id: source.workspace_id, from_id: other.id, to_id: source.tactic.id, role: "tactic" });
    const before = await listCoverageJoins(source.workspace_id);
    const copy = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(copy.workspace_id);
    const [live] = await listCoverageJoins(copy.workspace_id);
    const originalDimensions = before[0].dimensions as Record<string, unknown>;
    const dimensions = live.dimensions as { merge_history: CoverageJoinRow[] };
    expect(live).toMatchObject({ validated: false, rationale, dimensions: { validation_stale: true, actor,
      gap_revision: originalDimensions.gap_revision, tactic_revision: originalDimensions.tactic_revision,
      evidence: [copy.block_id_map[source.block_id]] } });
    expect(live.dimensions).not.toHaveProperty("copied_from_revisions");
    expect((await listCoveragePairs(copy.workspace_id))[0]).toMatchObject({ freshness: "stale", validated: false });
    expect(dimensions.merge_history).toHaveLength(2);
    const [previous, merged] = dimensions.merge_history;
    expect(previous).toMatchObject({ id: live.id, workspace_id: copy.workspace_id,
      gap_id: copy.claim_id_map[source.claim.id], tactic_id: copy.claim_id_map[source.tactic.id],
      rationale, dimensions: { actor, evidence: [copy.block_id_map[source.block_id]] } });
    expect(merged).toMatchObject({ workspace_id: copy.workspace_id, gap_id: copy.claim_id_map[source.claim.id], tactic_id: copy.claim_id_map[other.id] });
    expect(merged.id).not.toBe(imported.id);
    const legacy = merged.dimensions as { legacy_duplicates: CoverageJoinRow[]; legacy_rejection: CoverageJoinRow };
    expect(legacy.legacy_duplicates).toHaveLength(1);
    expect(legacy.legacy_duplicates[0]).toEqual(legacy.legacy_rejection);
    expect(legacy.legacy_rejection.id).not.toBe(historical.id);
    expect(legacy.legacy_rejection).toMatchObject({ workspace_id: copy.workspace_id,
      gap_id: copy.claim_id_map[source.claim.id], tactic_id: copy.claim_id_map[other.id],
      dimensions: { evidence: [copy.block_id_map[source.block_id]], actor, gap_revision: "stale-gap-token", tactic_revision: "stale-tactic-token",
        provenance: [{ source_file_id: copy.source_id_map[source.source_file_id], block_id: copy.block_id_map[source.block_id], quote: "The source evidence supports the proposed need." }] } });
    expect(await listCoverageJoins(source.workspace_id)).toEqual(before);
    const second = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(second.workspace_id);
    expect(second.baseline_fingerprint).toBe(copy.baseline_fingerprint);
    expect((await listCoverageJoins(second.workspace_id))[0].id).not.toBe(live.id);
  });

  it.each(["workspace", "claim", "evidence", "operation"])("rejects an unresolved historical coverage %s reference atomically", async kind => {
    const source = await fixture(), other = await fixture();
    const history = { ...source.coverage,
      workspace_id: kind === "workspace" ? other.workspace_id : source.workspace_id,
      gap_id: kind === "claim" ? other.claim.id : source.claim.id,
      dimensions: { evidence: [kind === "evidence" ? other.block_id : source.block_id],
        ...(kind === "operation" ? { retired_by_rollback: "missing-split-operation" } : {}) } };
    await withAccuracyWorkspaceMutation(source.workspace_id, async () => {
      await accuracyDb().update(t.accuracyCoverageJoins).set({ dimensions: { validation_stale: true, decision_history: [history] } })
        .where(eq(t.accuracyCoverageJoins.id, source.coverage.id));
    });
    const before = await listCoverageJoins(source.workspace_id);
    const workspaces = await accuracyDb().select().from(t.accuracyWorkspaces);
    const organizations = await accuracyDb().select().from(t.accuracyOrganizations);
    await expect(copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] }))
      .rejects.toMatchObject({ code: "unresolved_reference" });
    expect(await listCoverageJoins(source.workspace_id)).toEqual(before);
    expect(await accuracyDb().select().from(t.accuracyWorkspaces)).toEqual(workspaces);
    expect(await accuracyDb().select().from(t.accuracyOrganizations)).toEqual(organizations);
  });

  it("preserves history-only baseline exclusion without inventing copied snapshots", async () => {
    const source = await fixture();
    await accuracyDb().update(t.accuracyClaims).set({ metadata: { history_only: true } }).where(eq(t.accuracyClaims.id, source.claim.id));
    const copy = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(copy.workspace_id);
    const [copied] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, copy.claim_id_map[source.claim.id]));
    const repeated = await copyExperimentWorkspace({ source_workspace_id: copy.workspace_id, source_file_ids: [copy.source_id_map[source.source_file_id]] });
    createdWorkspaces.push(repeated.workspace_id);
    expect(copied.metadata).toMatchObject({ history_only: true, baseline_origin: { workspace_id: source.workspace_id, claim_id: source.claim.id } });
    expect(await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, copy.workspace_id))).toEqual([]);
  });

  it("remaps every supported metadata claim relationship inside the copy", async () => {
    const source = await fixture();
    const metadata = { parent_gap_id: source.claim.id, depends_on: [source.tactic.id], gap_ids: [source.claim.id],
      merged_into: source.tactic.id, merged_from: [source.claim.id],
      nested: { claim_id: source.claim.id, gap_id: source.claim.id, tactic_id: source.tactic.id } };
    await accuracyDb().update(t.accuracyClaims).set({ metadata }).where(eq(t.accuracyClaims.id, source.tactic.id));
    const copy = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(copy.workspace_id);
    const [copied] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, copy.claim_id_map[source.tactic.id]));
    expect(copied.metadata).toEqual({ baseline_origin: { workspace_id: source.workspace_id, claim_id: source.tactic.id }, parent_gap_id: copy.claim_id_map[source.claim.id], depends_on: [copy.claim_id_map[source.tactic.id]],
      gap_ids: [copy.claim_id_map[source.claim.id]], merged_into: copy.claim_id_map[source.tactic.id], merged_from: [copy.claim_id_map[source.claim.id]],
      nested: { claim_id: copy.claim_id_map[source.claim.id], gap_id: copy.claim_id_map[source.claim.id], tactic_id: copy.claim_id_map[source.tactic.id] } });
    const [original] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, source.tactic.id));
    expect(original.metadata).toEqual(metadata);
  });

  it.each(["omitted", "unknown", "cross-workspace"])("rejects %s metadata claim endpoints without leaving a copy", async (kind) => {
    const source = await fixture();
    const other = kind === "cross-workspace" ? await fixture() : source;
    const endpoint = kind === "unknown" ? "missing-claim" : (await insertClaim({ workspace_id: other.workspace_id,
      claim_type: "gap", statement: "Endpoint outside the selected sources" })).id;
    for (const field of ["parent_gap_id", "depends_on", "merged_into", "merged_from", "gap_ids", "claim_id", "gap_id", "tactic_id"]) {
      const metadata = { [field]: ["depends_on", "merged_from", "gap_ids"].includes(field) ? [endpoint] : endpoint };
      await accuracyDb().update(t.accuracyClaims).set({ metadata }).where(eq(t.accuracyClaims.id, source.claim.id));
      const beforeWorkspaces = await accuracyDb().select().from(t.accuracyWorkspaces);
      const beforeOrgs = await accuracyDb().select().from(t.accuracyOrganizations);
      await expect(copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] }))
        .rejects.toMatchObject({ code: "unresolved_reference" });
      expect(await accuracyDb().select().from(t.accuracyWorkspaces)).toEqual(beforeWorkspaces);
      expect(await accuracyDb().select().from(t.accuracyOrganizations)).toEqual(beforeOrgs);
      const [original] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, source.claim.id));
      expect(original.metadata).toEqual(metadata);
    }
  });

  it("copies a claim selected through table provenance even without a direct source id", async () => {
    const source = await fixture();
    await accuracyDb().update(t.accuracyClaims)
      .set({ source_file_id: null })
      .where(and(eq(t.accuracyClaims.id, source.claim.id), eq(t.accuracyClaims.workspace_id, source.workspace_id)));

    const copy = await copyExperimentWorkspace({
      source_workspace_id: source.workspace_id,
      source_file_ids: [source.source_file_id],
    });
    createdWorkspaces.push(copy.workspace_id);

    expect(copy.claim_id_map[source.claim.id]).toBeTruthy();
    const copiedClaims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    const copiedProvenance = await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, copy.workspace_id));
    expect(copiedClaims.map((row) => row.id)).toContain(copy.claim_id_map[source.claim.id]);
    expect(copiedProvenance[0]).toMatchObject({
      claim_id: copy.claim_id_map[source.claim.id],
      source_file_id: copy.source_id_map[source.source_file_id],
      block_id: copy.block_id_map[source.block_id],
    });
  });

  it("rejects a provenance source and block that belong to different sources", async () => {
    const source = await fixture();
    const secondSource = await insertSourceFile({
      workspace_id: source.workspace_id,
      org_id: source.org_id,
      filename: "second.txt",
      mime: "text/plain",
      checksum: "second-checksum",
    });
    const secondBlockId = newId("block");
    await persistParseBlocks({
      workspace_id: source.workspace_id,
      source_file_id: secondSource.id,
      parser: "test",
      blocks: [{ id: secondBlockId, source_file_id: secondSource.id, index: 0, kind: "prose", heading: null, text: "Second source evidence." }],
    });
    await accuracyDb().update(t.accuracyClaims).set({
      metadata: { provenance: [{ source_file_id: source.source_file_id, block_id: secondBlockId, quote: "crossed" }] },
    }).where(and(eq(t.accuracyClaims.id, source.claim.id), eq(t.accuracyClaims.workspace_id, source.workspace_id)));

    await expect(copyExperimentWorkspace({
      source_workspace_id: source.workspace_id,
      source_file_ids: [source.source_file_id, secondSource.id],
    })).rejects.toMatchObject({ code: "unresolved_reference" });

    await accuracyDb().update(t.accuracyClaims).set({ metadata: {} }).where(and(
      eq(t.accuracyClaims.id, source.claim.id), eq(t.accuracyClaims.workspace_id, source.workspace_id),
    ));
    await accuracyDb().update(t.accuracyProvenance).set({ block_id: secondBlockId }).where(and(
      eq(t.accuracyProvenance.id, source.provenance_id), eq(t.accuracyProvenance.workspace_id, source.workspace_id),
    ));
    await expect(copyExperimentWorkspace({
      source_workspace_id: source.workspace_id,
      source_file_ids: [source.source_file_id, secondSource.id],
    })).rejects.toMatchObject({ code: "unresolved_reference" });
  });

  it("keeps fingerprints stable for an unchanged baseline and changes the baseline fingerprint after a claim edit", async () => {
    const source = await fixture();
    const first = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    const second = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(first.workspace_id, second.workspace_id);
    expect(second.source_fingerprint).toBe(first.source_fingerprint);
    expect(second.baseline_fingerprint).toBe(first.baseline_fingerprint);

    await accuracyDb().update(t.accuracyClaims).set({ statement: "The materially changed proposed need requires evidence." })
      .where(and(eq(t.accuracyClaims.id, source.claim.id), eq(t.accuracyClaims.workspace_id, source.workspace_id)));
    const changed = await copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    createdWorkspaces.push(changed.workspace_id);
    expect(changed.source_fingerprint).toBe(first.source_fingerprint);
    expect(changed.baseline_fingerprint).not.toBe(first.baseline_fingerprint);
  });

  it("waits for the established workspace mutation lock before reading the baseline", async () => {
    const source = await fixture();
    const blocker = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release: () => void = () => undefined;
    let announceLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { announceLock = resolve; });
    const holdLock = new Promise<void>((resolve) => { release = resolve; });
    const blockerTransaction = blocker.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`omission:${source.workspace_id}`}, 0))`;
      announceLock();
      await holdLock;
    });

    try {
      await lockAcquired;
      const copyPromise = copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
      const outcome = await Promise.race([
        copyPromise.then(() => "finished" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      expect(outcome).toBe("waiting");
      release();
      const copy = await copyPromise;
      createdWorkspaces.push(copy.workspace_id);
      await blockerTransaction;
    } finally {
      release();
      await blockerTransaction;
      await blocker.end({ timeout: 5 });
    }
  });

  it("rejects a nested copy after an outer transaction has already issued a query", async () => {
    const source = await fixture();
    await expect(withAccuracyTransaction(async () => {
      await accuracyDb().select({ id: t.accuracyWorkspaces.id }).from(t.accuracyWorkspaces)
        .where(eq(t.accuracyWorkspaces.id, source.workspace_id));
      return copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] });
    })).rejects.toMatchObject({ name: "ExperimentCopyError", code: "nested_transaction" });
    expect(await accuracyDb().select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.org_id, source.org_id))).toHaveLength(1);
  });

  it.each([
    ["access mode", { accessMode: "read only" }],
    ["deferrability", { deferrable: true }],
  ] as const)("rejects nested transaction %s configuration before executing it", async (_label, config) => {
    let nestedOperationRan = false;

    await expect(withAccuracyTransaction(async () => withAccuracyTransaction(async () => {
      nestedOperationRan = true;
    }, config))).rejects.toMatchObject({
      name: "AccuracyTransactionError",
      code: "nested_config_unsupported",
    });

    expect(nestedOperationRan).toBe(false);
  });

  it("keeps later reads on the same repeatable-read snapshot after an ordinary writer commits", async () => {
    const source = await fixture();
    const nextStatement = "The independently committed statement is visible only to later snapshots.";
    const writer = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const observed = await withAccuracyTransaction(async () => {
        const before = (await accuracyDb().select({ statement: t.accuracyClaims.statement })
          .from(t.accuracyClaims).where(eq(t.accuracyClaims.id, source.claim.id)))[0]?.statement;
        await writer`update accuracy_claims set statement = ${nextStatement} where id = ${source.claim.id}`;
        const after = (await accuracyDb().select({ statement: t.accuracyClaims.statement })
          .from(t.accuracyClaims).where(eq(t.accuracyClaims.id, source.claim.id)))[0]?.statement;
        return { before, after };
      }, { isolationLevel: "repeatable read" });
      expect(observed).toEqual({ before: source.claim.statement, after: source.claim.statement });
    } finally {
      await writer.end({ timeout: 5 });
    }
  });

  it.each([
    ["unknown source", "missing-source"],
    ["cross-workspace source", "cross-workspace"],
  ])("rejects an %s before creating an experiment workspace", async (_label, source_kind) => {
    const source = await fixture();
    const otherOrg = await createOrganization(`other-${newId("org")}`);
    const otherWorkspace = await createWorkspace({ org_id: otherOrg, name: "Other", slug: newId("slug") });
    createdWorkspaces.push(otherWorkspace);
    const source_file_id = source_kind === "cross-workspace"
      ? await insertSourceFile({ workspace_id: otherWorkspace, org_id: otherOrg, filename: "other.txt", mime: "text/plain", checksum: "other" }).then((row) => row.id)
      : "missing-source";
    await expect(copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source_file_id] }))
      .rejects.toThrow(/source file|workspace/i);
    expect(await accuracyDb().select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.org_id, source.org_id))).toHaveLength(1);
  });

  it("rejects a gold-seeded claim without leaving a workspace behind", async () => {
    const source = await fixture();
    await accuracyDb().update(t.accuracyClaims).set({ metadata: { reference_pack_id: "gold-pack", source_badge: "gold-source" } }).where(and(eq(t.accuracyClaims.id, source.claim.id), eq(t.accuracyClaims.workspace_id, source.workspace_id)));
    await expect(copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] }))
      .rejects.toThrow(/gold|reference pack/i);
    expect(await accuracyDb().select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.org_id, source.org_id))).toHaveLength(1);
  });

  it("rejects an unresolved provenance source omission without leaving a workspace behind", async () => {
    const source = await fixture();
    const omittedSource = await insertSourceFile({ workspace_id: source.workspace_id, org_id: source.org_id, filename: "omitted.txt", mime: "text/plain", checksum: "omitted" });
    await accuracyDb().update(t.accuracyClaims).set({ metadata: { provenance: [{ source_file_id: omittedSource.id, block_id: "missing-block", quote: "omitted" }] } }).where(and(eq(t.accuracyClaims.id, source.claim.id), eq(t.accuracyClaims.workspace_id, source.workspace_id)));
    await expect(copyExperimentWorkspace({ source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id] }))
      .rejects.toThrow(/source|provenance|copy/i);
    expect(await accuracyDb().select().from(t.accuracyWorkspaces).where(eq(t.accuracyWorkspaces.org_id, source.org_id))).toHaveLength(1);
    expect(await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.id, omittedSource.id))).toHaveLength(1);
  });
});
