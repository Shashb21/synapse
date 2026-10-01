import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import {
  createOrganization,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
} from "@/accuracy/store/tenant";
import { insertClaim } from "@/accuracy/store/claim-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertCoverageJoin } from "@/accuracy/store/coverage-store";
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
