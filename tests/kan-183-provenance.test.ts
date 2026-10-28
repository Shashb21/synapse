/** Database regressions for durable evidence and safe historic parse mutations. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { applyClaimValidation, claimMetadata, getClaim, insertClaim, persistClaimPatch, updateClaimMetadata } from "@/accuracy/store/claim-store";
import * as claimStore from "@/accuracy/store/claim-store";
import { manualMergeClaims, unmergeClaim } from "@/accuracy/store/claim-merge";
import { insertCoverageJoin, listCoverageJoins } from "@/accuracy/store/coverage-store";
import { updateClaim, writeClaimRow } from "@/accuracy/store/claim-edit";
import { mergeDedupeModule } from "@/accuracy/modules/merge-dedupe/module";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { deleteParseBlock, editParseBlock, mergeParseBlocks, persistParseBlocks, persistParseBlocksDetailed, readParseBlocks, readParseBlocksWithMeta, splitParseBlock } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { repointMetadataProvenance, withProvenanceTransaction } from "@/accuracy/store/provenance-store";
import * as t from "@/accuracy/store/schema";

const actor = { name: "Evidence reviewer", function: "medical_affairs" as const };
const rationale = "Preserve cited evidence";

async function fixture() {
  await ensureAccuracySchema();
  const workspace_id = `kan183-${randomUUID()}`;
  const source = await insertSourceFile({ workspace_id, org_id: "kan183-org", filename: "evidence.txt", mime: "text/plain", checksum: randomUUID() });
  const blocks = ["Need OS   evidence. Registry planned.", "Independent second paragraph."].map((text, index) => ({
    id: `${source.id}-B${index}`, source_file_id: source.id, index, kind: "prose" as const, heading: null, text,
  }));
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks });
  const span = { source_file_id: source.id, block_id: blocks[0]!.id, quote: "OS evidence" };
  return { workspace_id, source, blocks, span };
}

async function provenance(workspace_id: string) {
  return accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, workspace_id));
}

async function historic(f: Awaited<ReturnType<typeof fixture>>, spans: unknown) {
  const id = `historic-${randomUUID()}`;
  await accuracyDb().insert(t.accuracyClaims).values({ id, workspace_id: f.workspace_id, claim_type: "gap", statement: "Historic gap", status: "draft", validated: false, source_file_id: f.source.id, metadata: { provenance: spans }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return id;
}

function claim(f: Awaited<ReturnType<typeof fixture>>, spans: unknown = [f.span]) {
  return insertClaim({ workspace_id: f.workspace_id, source_file_id: f.source.id, claim_type: "gap", statement: "Need evidence", metadata: { provenance: spans } });
}

describe("KAN-183 durable claim provenance", () => {
  it("persists validated normalized-whitespace evidence in both representations", async () => {
    const f = await fixture(); // Arrange
    const saved = await claim(f); // Act
    const rows = await provenance(f.workspace_id); // Assert
    expect(saved.metadata).toMatchObject({ provenance: [f.span] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: f.workspace_id, claim_id: saved.id, ...f.span });
  });

  it.each(["invented", "multi-span", "foreign-source", "foreign-workspace", "foreign-block", "malformed"])("rejects %s evidence without partial writes", async (invalid) => {
    const f = await fixture();
    const other = await fixture();
    const spans = invalid === "multi-span" ? [f.span, { ...f.span, quote: "Invented evidence" }]
      : invalid === "foreign-source" ? [{ ...f.span, source_file_id: other.source.id }]
      : invalid === "foreign-workspace" ? [other.span]
      : invalid === "foreign-block" ? [{ ...f.span, block_id: other.span.block_id }]
      : invalid === "malformed" ? [{ block_id: f.span.block_id }]
      : [{ ...f.span, quote: "Invented evidence" }];
    await expect(claim(f, spans)).rejects.toThrow(/provenance|quote|source|block/i);
    expect(await provenance(f.workspace_id)).toEqual([]);
    const rows = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, f.workspace_id));
    expect(rows).toEqual([]);
  });

  it("allows manual claims without citations", async () => {
    const f = await fixture();
    const saved = await insertClaim({ workspace_id: f.workspace_id, claim_type: "gap", statement: "Manual gap" });
    expect(saved.source_file_id).toBeNull();
    expect(await provenance(f.workspace_id)).toEqual([]);
  });

  it("rejects a foreign source even for a claim without spans", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(insertClaim({ workspace_id: f.workspace_id, source_file_id: other.source.id, claim_type: "gap", statement: "Wrong source" })).rejects.toThrow(/source/i);
  });

  it("rejects stale extraction after source text changes", async () => {
    const f = await fixture();
    await editParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, text: "Replaced source text", actor, rationale });
    await expect(claim(f)).rejects.toThrow(/quote/i);
    expect(await provenance(f.workspace_id)).toEqual([]);
  });

  it("waits for an in-flight source mutation and then validates the committed text", async () => {
    const f = await fixture();
    // A separate pool is essential: a single test connection would serialize
    // calls by itself and could hide a missing application lock.
    const writer = postgres(process.env.DATABASE_URL!, { max: 2 });
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const mutation = writer.begin(async (db) => {
      await db`select pg_advisory_xact_lock(hashtext('accuracy-provenance'), hashtext(${f.workspace_id}))`;
      await db`update accuracy_parse_blocks set text = 'Changed while extraction was running' where id = ${f.span.block_id}`;
      ready();
      await gate;
    });
    try {
      await locked;
      const pending = claim(f).then(() => ({ ok: true, error: "" }), (error: Error) => ({ ok: false, error: error.message }));
      await vi.waitFor(async () => {
        const [row] = await writer`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and classid = hashtext('accuracy-provenance')::oid and objid = hashtext(${f.workspace_id})::oid and not granted`;
        expect(row?.waiting).toBe(1);
      }, { timeout: 2000, interval: 10 });
      release();
      await mutation;
      expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/quote_not_substring/) });
      expect(await provenance(f.workspace_id)).toEqual([]);
    } finally {
      release();
      await mutation;
      await writer.end();
    }
  });

  it("keeps newly cited blocks during reparse and permits edits retaining whitespace-normalized quotes", async () => {
    const f = await fixture();
    await claim(f);
    const result = await persistParseBlocksDetailed({ workspace_id: f.workspace_id, source_file_id: f.source.id, parser: "test", blocks: [{ ...f.blocks[0]!, text: "Replacement parse" }] });
    expect(result.kept_cited).toBe(1);
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, text: "Need OS\nevidence remains.", actor, rationale })).resolves.toMatchObject({ text: "Need OS\nevidence remains." });
    await expect(deleteParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, actor, rationale })).rejects.toThrow(/orphan/i);
  });
});

describe("KAN-183 historic citations", () => {
  it("reconciles source-bearing dedupe survivors and permits preserving edit, split and merge", async () => {
    const f = await fixture();
    const second = await insertSourceFile({ workspace_id: f.workspace_id, org_id: "kan183-org", filename: "second.txt", mime: "text/plain", checksum: randomUUID() });
    const block = { ...f.blocks[0]!, id: `${second.id}-B0`, source_file_id: second.id };
    await persistParseBlocks({ workspace_id: f.workspace_id, source_file_id: second.id, parser: "test", blocks: [block] });
    const spans = [f.span, { source_file_id: second.id, block_id: block.id, quote: "Registry planned." }];
    const originals = await Promise.all(spans.map((span) => insertClaim({ workspace_id: f.workspace_id, source_file_id: span.source_file_id, claim_type: "gap", statement: "Identical need", metadata: { provenance: [span] } })));
    const ctx = { workspace_id: f.workspace_id, run: { note: () => {} } } as unknown as AccuracyModuleContext;
    const result = await mergeDedupeModule.run({ workspace_id: f.workspace_id }, ctx);
    expect(result.output.merged).toBe(1);
    const survivorId = result.output.merges[0]!.survivor_id;
    const survivor = originals.find((row) => row.id === survivorId)!;
    const foreign = spans.find((span) => span.source_file_id !== survivor.source_file_id)!;

    // Reproduce a historic dedupe survivor whose foreign span exists only in
    // metadata, then let reconciliation backfill it through verified source/block bindings.
    await accuracyDb().delete(t.accuracyProvenance).where(and(eq(t.accuracyProvenance.claim_id, survivorId), eq(t.accuracyProvenance.source_file_id, foreign.source_file_id)));

    await readParseBlocksWithMeta(f.workspace_id, foreign.source_file_id);
    expect((await provenance(f.workspace_id)).filter((row) => row.claim_id === survivorId)).toHaveLength(2);
    await editParseBlock({ workspace_id: f.workspace_id, block_id: foreign.block_id, text: "OS evidence. Registry planned. More text.", actor, rationale });
    const split = await splitParseBlock({ workspace_id: f.workspace_id, block_id: foreign.block_id, at_text: "Registry", actor, rationale });
    await mergeParseBlocks({ workspace_id: f.workspace_id, block_id: split.first_id, next_block_id: split.second_id, actor, rationale });
    await readParseBlocksWithMeta(f.workspace_id, foreign.source_file_id);
    expect((await provenance(f.workspace_id)).filter((row) => row.claim_id === survivorId)).toHaveLength(2);
  });

  it("accepts truthful multisource historic bindings and rejects a mismatched block source", async () => {
    const f = await fixture();
    const second = await insertSourceFile({ workspace_id: f.workspace_id, org_id: "kan183-org", filename: "unmerged.txt", mime: "text/plain", checksum: randomUUID() });
    const block = { ...f.blocks[0]!, id: `${second.id}-B0`, source_file_id: second.id };
    await persistParseBlocks({ workspace_id: f.workspace_id, source_file_id: second.id, parser: "test", blocks: [block] });
    // A new extraction is still constrained to its declared single source.
    await expect(claim(f, [{ ...f.span, source_file_id: second.id, block_id: block.id }])).rejects.toThrow(/claim_source_mismatch/);
    const id = await historic(f, [{ ...f.span, source_file_id: second.id, block_id: block.id }]);
    await readParseBlocksWithMeta(f.workspace_id, second.id);
    expect((await provenance(f.workspace_id)).filter((row) => row.claim_id === id)).toHaveLength(1);
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: block.id, text: `${block.text} More text.`, actor, rationale })).resolves.toBeDefined();
    const invalid = await historic(f, [{ ...f.span, block_id: block.id }]);
    await readParseBlocksWithMeta(f.workspace_id, second.id);
    expect((await provenance(f.workspace_id)).filter((row) => row.claim_id === invalid)).toEqual([]);
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: block.id, text: `${block.text} Changed again.`, actor, rationale })).rejects.toThrow(/unresolved|orphan/i);
  });

  it("retains valid accumulated source evidence after merge and unmerge", async () => {
    const f = await fixture();
    const second = await insertSourceFile({ workspace_id: f.workspace_id, org_id: "kan183-org", filename: "donor.txt", mime: "text/plain", checksum: randomUUID() });
    const block = { ...f.blocks[0]!, id: `${second.id}-B0`, source_file_id: second.id };
    await persistParseBlocks({ workspace_id: f.workspace_id, source_file_id: second.id, parser: "test", blocks: [block] });
    const survivor = await claim(f);
    const duplicate = await insertClaim({ workspace_id: f.workspace_id, source_file_id: second.id, claim_type: "gap", statement: "Other need", metadata: { provenance: [{ ...f.span, source_file_id: second.id, block_id: block.id }] } });
    await manualMergeClaims({ workspace_id: f.workspace_id, survivor_id: survivor.id, duplicate_id: duplicate.id, actor, rationale });
    await unmergeClaim({ workspace_id: f.workspace_id, claim_id: duplicate.id, actor, rationale });
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: block.id, text: `${block.text} More text.`, actor, rationale })).resolves.toBeDefined();
    expect((await getClaim(f.workspace_id, survivor.id))?.metadata).toMatchObject({ merged_from: [], provenance: [{ source_file_id: f.source.id }, { source_file_id: second.id }] });
  });

  it("rolls back dedupe status and coverage when its evidence snapshot becomes stale, then retries without losing evidence", async () => {
    const f = await fixture();
    const originals = [await claim(f), await claim(f, [{ ...f.span, quote: "Registry planned." }])];
    const tactic = await insertClaim({ workspace_id: f.workspace_id, claim_type: "tactic", statement: "Tactic" });
    for (const row of originals) await insertCoverageJoin({ workspace_id: f.workspace_id, gap_id: row.id, tactic_id: tactic.id, overall: "covers" });
    const before = await listCoverageJoins(f.workspace_id);
    const list = claimStore.listClaims;
    let split!: Awaited<ReturnType<typeof splitParseBlock>>;
    const spy = vi.spyOn(claimStore, "listClaims").mockImplementationOnce(async (...args) => {
      const snapshot = await list(...args);
      split = await splitParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, at_text: "Registry", actor, rationale });
      return snapshot;
    });
    const ctx = { workspace_id: f.workspace_id, run: { note: () => {} } } as unknown as AccuracyModuleContext;
    try {
      await expect(mergeDedupeModule.run({ workspace_id: f.workspace_id }, ctx)).rejects.toThrow(/quote|stale/i);
    } finally {
      spy.mockRestore();
    }
    for (const row of originals) expect((await getClaim(f.workspace_id, row.id))?.status).toBe("draft");
    expect(await listCoverageJoins(f.workspace_id)).toEqual(before);
    const retry = await mergeDedupeModule.run({ workspace_id: f.workspace_id }, ctx);
    expect(retry.output.merged).toBe(1);
    const survivor = await getClaim(f.workspace_id, retry.output.merges[0]!.survivor_id);
    expect(claimMetadata(survivor!).provenance).toEqual(expect.arrayContaining([{ ...f.span }, { ...f.span, block_id: split.second_id, quote: "Registry planned." }]));
    expect((await provenance(f.workspace_id)).filter((row) => row.claim_id === survivor!.id)).toHaveLength(2);
  });

  it.each(["human", "dedupe"])("rolls back a %s merge when survivor evidence validation fails", async (mode) => {
    const f = await fixture();
    const survivor = await insertClaim({ workspace_id: f.workspace_id, source_file_id: f.source.id, claim_type: "gap", statement: "Historic gap", metadata: { provenance: [f.span] } });
    const duplicateId = await historic(f, [{ ...f.span, quote: "Invented legacy evidence" }]);
    const tactic = await insertClaim({ workspace_id: f.workspace_id, claim_type: "tactic", statement: "Tactic" });
    await insertCoverageJoin({ workspace_id: f.workspace_id, gap_id: duplicateId, tactic_id: tactic.id, overall: "covers" });
    const before = await listCoverageJoins(f.workspace_id);
    const ctx = { workspace_id: f.workspace_id, run: { note: () => {} } } as unknown as AccuracyModuleContext;
    const merging = mode === "human"
      ? manualMergeClaims({ workspace_id: f.workspace_id, survivor_id: survivor.id, duplicate_id: duplicateId, actor, rationale })
      : mergeDedupeModule.run({ workspace_id: f.workspace_id }, ctx);
    await expect(merging).rejects.toThrow(/quote_not_substring/);
    expect((await getClaim(f.workspace_id, duplicateId))?.status).toBe("draft");
    expect((await getClaim(f.workspace_id, duplicateId))?.metadata).not.toHaveProperty("merged_into");
    expect((await getClaim(f.workspace_id, survivor.id))?.metadata).toEqual(survivor.metadata);
    expect(await listCoverageJoins(f.workspace_id)).toEqual(before);
    expect((await provenance(f.workspace_id)).filter((row) => row.claim_id === survivor.id)).toHaveLength(1);
  });

  it.each(["metadata", "patch", "human-row"])("preserves repointed provenance against stale %s snapshots", async (writer) => {
    const f = await fixture();
    const saved = await claim(f, [{ ...f.span, quote: "Registry planned." }]);
    const split = await splitParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, at_text: "Registry", actor, rationale });
    const metadata = { ...claimMetadata(saved), annotation: "Added after split" };
    if (writer === "metadata") await updateClaimMetadata({ workspace_id: f.workspace_id, claim_id: saved.id, metadata });
    else if (writer === "patch") await persistClaimPatch({ workspace_id: f.workspace_id, claim_id: saved.id, metadata });
    else await writeClaimRow({ workspace_id: f.workspace_id, claim: saved, metadata });
    expect((await getClaim(f.workspace_id, saved.id))?.metadata).toMatchObject({ annotation: "Added after split", provenance: [{ block_id: split.second_id }] });
    expect((await provenance(f.workspace_id))[0]?.block_id).toBe(split.second_id);
  });

  it("preserves merge repointing while an earlier validation update is paused", async () => {
    const f = await fixture();
    const saved = await claim(f, [{ ...f.span, block_id: f.blocks[1]!.id, quote: "Independent second paragraph." }]);
    const db = accuracyDb();
    const update = db.update.bind(db);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { ready = resolve; });
    // Pause immediately before the validation UPDATE executes, after any old
    // read/metadata snapshot. Transaction-local merge writes use another builder.
    const spy = vi.spyOn(db, "update").mockImplementationOnce((table) => {
      const builder = update(table);
      const set = builder.set.bind(builder);
      vi.spyOn(builder, "set").mockImplementationOnce((values) => {
        const query = set(values);
        const then = query.then.bind(query);
        Object.defineProperty(query, "then", { value: (...callbacks: Parameters<typeof query.then>) => {
          ready();
          return gate.then(() => then(...callbacks));
        } });
        return query;
      });
      return builder;
    });
    const pending = applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [saved.id], action: "validate", rationale, actor });
    try {
      await paused;
      await mergeParseBlocks({ workspace_id: f.workspace_id, block_id: f.blocks[0]!.id, next_block_id: f.blocks[1]!.id, actor, rationale });
      release();
      const result = await pending;
      expect(result.claims[0]?.metadata).toMatchObject({ validation: { action: "validate" }, provenance: [{ block_id: f.blocks[0]!.id }] });
      expect((await getClaim(f.workspace_id, saved.id))?.metadata).toMatchObject({ validation: { action: "validate" }, provenance: [{ block_id: f.blocks[0]!.id }] });
      expect((await provenance(f.workspace_id))[0]?.block_id).toBe(f.blocks[0]!.id);
      await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: f.blocks[0]!.id, text: "Independent second paragraph. Preserved.", actor, rationale })).resolves.toBeDefined();
    } finally {
      release();
      await pending;
      spy.mockRestore();
    }
  });

  it("removes trusted rows when a human replaces a quote with an unresolved annotation", async () => {
    const f = await fixture();
    const saved = await claim(f);
    await updateClaim({ workspace_id: f.workspace_id, claim_id: saved.id, patch: { provenance_quote: "Human annotation outside source text" }, rationale, actor });
    expect(await provenance(f.workspace_id)).toEqual([]);
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, text: `${f.blocks[0]!.text} More text.`, actor, rationale })).rejects.toThrow(/unresolved|orphan/i);
  });

  it("rejects stale intentional evidence replacements without undoing a split", async () => {
    const f = await fixture();
    const saved = await claim(f, [{ ...f.span, quote: "Registry planned." }]);
    const split = await splitParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, at_text: "Registry", actor, rationale });
    await expect(writeClaimRow({ workspace_id: f.workspace_id, claim: saved, metadata: { ...claimMetadata(saved), provenance: [{ ...f.span, quote: "Registry" }] } })).rejects.toThrow(/stale_provenance_retry/);
    expect((await getClaim(f.workspace_id, saved.id))?.metadata).toMatchObject({ provenance: [{ block_id: split.second_id, quote: "Registry planned." }] });
    expect((await provenance(f.workspace_id))[0]?.block_id).toBe(split.second_id);
  });

  it("rejects invented non-human evidence replacements atomically", async () => {
    const f = await fixture();
    const saved = await claim(f);
    await expect(persistClaimPatch({ workspace_id: f.workspace_id, claim_id: saved.id, metadata: { provenance: [{ ...f.span, quote: "Invented" }] }, provenance_update: { previous: [f.span] } })).rejects.toThrow(/quote_not_substring/);
    expect((await provenance(f.workspace_id))[0]).toMatchObject(f.span);
    expect((await getClaim(f.workspace_id, saved.id))?.metadata).toMatchObject({ provenance: [f.span] });
  });

  it("retains a validation annotation committed after repointing read its snapshot", async () => {
    const f = await fixture();
    const saved = await claim(f);
    const writer = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await withProvenanceTransaction(f.workspace_id, async (db) => {
        const update = db.update.bind(db);
        const spy = vi.spyOn(db, "update").mockImplementationOnce((table) => {
          const builder = update(table);
          const set = builder.set.bind(builder);
          vi.spyOn(builder, "set").mockImplementationOnce((values) => {
            const query = set(values);
            const then = query.then.bind(query);
            Object.defineProperty(query, "then", { value: async (...callbacks: Parameters<typeof query.then>) => {
              await writer`update accuracy_claims set metadata = jsonb_set(metadata, '{validation}', '{"action":"validate","rationale":"Concurrent annotation"}'::jsonb) where id = ${saved.id}`;
              return then(...callbacks);
            } });
            return query;
          });
          return builder;
        });
        try {
          // Identity repoint exercises the exact write path without creating
          // an invalid cross-block quote merely for this interleaving test.
          await repointMetadataProvenance(db, f.workspace_id, f.span.block_id, f.span.block_id);
        } finally {
          spy.mockRestore();
        }
      });
      expect((await getClaim(f.workspace_id, saved.id))?.metadata).toMatchObject({ validation: { rationale: "Concurrent annotation" }, provenance: [f.span] });
    } finally {
      await writer.end();
    }
  });

  it("guards metadata-only citations and reconciles them idempotently", async () => {
    const f = await fixture();
    const id = await historic(f, [f.span]);
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, text: "Lost quote", actor, rationale })).rejects.toThrow(/orphan/i);
    await expect(deleteParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, actor, rationale })).rejects.toThrow(/orphan/i);
    for (let i = 0; i < 2; i++) {
      const rows = await readParseBlocksWithMeta(f.workspace_id, f.source.id);
      expect(rows[0]?.provenance.cited_by).toContain(id);
    }
    expect(await provenance(f.workspace_id)).toHaveLength(1);
  });

  it.each([
    [{ block_id: "TARGET", quote: "" }],
    [{ block_id: "TARGET", quote: "Invented historic quote" }],
    [{ block_id: "missing-block", quote: "OS evidence" }],
    [{ quote: "OS evidence" }],
    [null],
    "unparseable",
  ])("protects malformed historic references without certifying them: %j", async (spans) => {
    const f = await fixture();
    const serialized = JSON.parse(JSON.stringify(spans).replaceAll("TARGET", f.span.block_id));
    await historic(f, serialized);
    const rows = await readParseBlocksWithMeta(f.workspace_id, f.source.id);
    expect(rows[0]?.provenance.cited_by).toHaveLength(1);
    expect(await provenance(f.workspace_id)).toEqual([]);
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, text: "New text", actor, rationale })).rejects.toThrow(/orphan|unresolved/i);
    await expect(deleteParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, actor, rationale })).rejects.toThrow(/orphan|unresolved/i);
    const reparsed = await persistParseBlocksDetailed({ workspace_id: f.workspace_id, source_file_id: f.source.id, parser: "test", blocks: [] });
    expect(reparsed.kept_cited).toBeGreaterThan(0);
    expect((await readParseBlocks(f.workspace_id, f.source.id)).some((b) => b.id === f.span.block_id)).toBe(true);
  });

  it("protects malformed historic relational evidence from text edits", async () => {
    const f = await fixture();
    await accuracyDb().insert(t.accuracyProvenance).values({ id: randomUUID(), workspace_id: f.workspace_id, claim_id: "historic-empty-quote", source_file_id: f.source.id, block_id: f.span.block_id, quote: "" });
    await expect(editParseBlock({ workspace_id: f.workspace_id, block_id: f.span.block_id, text: "New text", actor, rationale })).rejects.toThrow(/orphan|unresolved/i);
  });

  it("repoints relational and metadata citations through split and merge", async () => {
    const f = await fixture();
    const span = { ...f.span, quote: "Registry planned." };
    const id = await historic(f, [span]);
    const split = await splitParseBlock({ workspace_id: f.workspace_id, block_id: span.block_id, at_text: "Registry", actor, rationale });
    expect((await provenance(f.workspace_id))[0]?.block_id).toBe(split.second_id);
    let [saved] = await accuracyDb().select().from(t.accuracyClaims).where(and(eq(t.accuracyClaims.workspace_id, f.workspace_id), eq(t.accuracyClaims.id, id)));
    expect(saved?.metadata).toMatchObject({ provenance: [{ ...span, block_id: split.second_id }] });
    await mergeParseBlocks({ workspace_id: f.workspace_id, block_id: split.first_id, next_block_id: split.second_id, actor, rationale });
    expect((await provenance(f.workspace_id))[0]?.block_id).toBe(split.first_id);
    [saved] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, id));
    expect(saved?.metadata).toMatchObject({ provenance: [span] });
    await readParseBlocksWithMeta(f.workspace_id, f.source.id);
    expect(await provenance(f.workspace_id)).toHaveLength(1);
  });
});
