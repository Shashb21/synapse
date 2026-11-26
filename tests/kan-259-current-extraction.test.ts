/** Stages consume the current, human-editable source while preserving S1 history. */
import { beforeAll, expect, it } from "vitest";
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import { loadState, resetDemoSetup } from "@/lib/iegp/store";
import { addSourceBlock, deleteSourceBlock, editSourceBlock, listSourceBlocks } from "@/lib/iegp/source-blocks";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";
import { tacticExtractModule } from "@/modules/stages/s3-tactic-extract/module";

const actor = { name: "Source reviewer", function: "medical_affairs" } as const;
const lead = { actor, role: actor.function };
const edited = "Limited evidence compares fictional Vela with current care.";
const inserted = "A prospective Vela registry will evaluate treatment in older adults.";
let oldId: string, currentId: string, sourceId: string, insertedId: string, editedId: string;

beforeAll(async () => {
  await resetDemoSetup();
  await wipePlatform(["source_files", "parsed_documents", "gap_candidates", "tactic_candidates"]);
  await runStage({ stage: "S0", input: { demo_ids: ["heor-interview", "medical-kol"] }, ...lead });
  await runStage({ stage: "S1", input: {}, ...lead });
  const original = (await listParsedDocuments())[0]!;
  oldId = original.id;
  sourceId = original.source_id;
  await runStage({ stage: "S1", input: { file_ids: [original.file_id] }, ...lead });
  currentId = (await listParsedDocuments()).find(doc => doc.source_id === sourceId)!.id;
  const blocks = await listSourceBlocks(sourceId);
  editedId = blocks[0]!.id;
  await editSourceBlock({ block_id: editedId, text: edited, actor, rationale: "Correct the interview wording." });
  for (const block of blocks.slice(1)) {
    await deleteSourceBlock({ block_id: block.id, actor, rationale: "Remove duplicate transcript." });
  }
  insertedId = (await addSourceBlock({ source_id: sourceId, after_block_id: null, text: inserted, actor, rationale: "Put study context first." })).id;
}, 60_000);

it.each([gapExtractModule, tacticExtractModule])("$manifest.stage selects one current parse with live block order, scoped by an old document id", async stage => {
  const input = stage.inputSchema.parse({ document_ids: [oldId], dry_run: true });
  const freeze = async (document_ids?: string[]) => {
    const facts = await stage.freeze!({ ...input, document_ids });
    return facts.documents as Awaited<ReturnType<typeof listParsedDocuments>>;
  };
  const selected = await freeze([oldId]);
  expect(selected.map(doc => doc.id)).toEqual([currentId]);
  expect(selected[0]!.blocks.map(block => [block.id, block.text])).toEqual([[insertedId, inserted], [editedId, edited]]);
  expect((await freeze()).filter(doc => doc.source_id === sourceId)).toHaveLength(1);
  expect(await freeze(["missing-document"])).toEqual([]);
  expect(await freeze([])).toEqual([]);
  const run = await runStage<{accepted: {document_id: string; source_id: string}[]}>({
    stage: stage.manifest.stage, input, ...lead,
  });
  expect(run.output.accepted.length).toBeGreaterThan(0);
  expect(run.output.accepted.every(row => row.document_id === currentId && row.source_id === sourceId)).toBe(true);
  expect((await listParsedDocuments([oldId]))[0]!.blocks[0]!.text).not.toBe(edited);
});

it("records the edited block on the extracted need and keeps an empty source empty", async () => {
  await runStage({stage: "S2", input: {document_ids: [oldId]}, ...lead});
  const state = await loadState();
  expect(state.needs).toContainEqual(expect.objectContaining({source_id: sourceId, source_quote: edited, block_id: editedId}));
  const other = (await listParsedDocuments()).find(doc => doc.source_id !== sourceId)!;
  for (const block of await listSourceBlocks(other.source_id)) {
    await deleteSourceBlock({block_id: block.id, actor, rationale: "Withdraw the transcript."});
  }
  const result = await runStage<{proposed: number}>({stage: "S2", input: {document_ids: [other.id]}, ...lead});
  expect(result.output.proposed).toBe(0);
});
