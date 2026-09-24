import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { registerAccuracyStack } from "@/accuracy";
import { runAccuracyModule } from "@/accuracy/kernel/run";
import { GET as blocksGet, POST as blocksPost } from "@/app/api/accuracy/sources/blocks/route";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import {
  ProvenanceConflictError,
  addParseBlock,
  deleteParseBlock,
  editParseBlock,
  listParseBlockEdits,
  mergeParseBlocks,
  persistDroppedUnits,
  persistParseBlocks,
  persistParseBlocksDetailed,
  readParseBlocks,
  readParseBlocksWithMeta,
  readSourceStakeholder,
  recordLlmStakeholder,
  restoreDroppedUnit,
  setSourceStakeholder,
  splitParseBlock,
  listDroppedUnits,
} from "@/accuracy/store/parse-store";
import * as t from "@/accuracy/store/schema";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";

registerAccuracyStack();

const ACTOR = { name: "Dana Reviewer", function: "medical_affairs" };

const AI_TEXTS = [
  "Unmet need: comparative OS evidence versus pembrolizumab in 1L NSCLC.",
  "Payers in EU5 ask for real-world persistence data beyond 12 months.",
  "A chart review in ESCC is planned for 2027.",
];

async function seed(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-mb-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({ org_id, name: `MB ${label}`, slug: `mb-${label}-${Date.now()}` });
  const source = await insertSourceFile({
    workspace_id,
    org_id,
    filename: `${label}.txt`,
    mime: "text/plain",
    checksum: `mb-${label}-${Date.now()}`,
  });
  const blocks = AI_TEXTS.map((text, index) => ({
    id: `${source.id}-B${String(index + 1).padStart(3, "0")}`,
    source_file_id: source.id,
    index,
    kind: "prose" as const,
    heading: null,
    text,
  }));
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "llm", blocks });
  return { org_id, workspace_id, source_file_id: source.id, ids: blocks.map((b) => b.id) };
}

async function cite(workspace_id: string, source_file_id: string, block_id: string, quote: string, claim_id: string) {
  await accuracyDb().insert(t.accuracyProvenance).values({
    id: `prov-${claim_id}-${Date.now()}`,
    workspace_id,
    claim_id,
    source_file_id,
    block_id,
    quote,
  });
}

function post(body: Record<string, unknown>) {
  return blocksPost(
    new Request("http://localhost/api/accuracy/sources/blocks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
}

describe("accuracy parse blocks: human edit, add, split, merge, delete", () => {
  it("requires a rationale and records edits as human with the model's original kept", async () => {
    const s = await seed("edit");
    await expect(
      editParseBlock({ workspace_id: s.workspace_id, block_id: s.ids[0]!, text: "x", rationale: " ", actor: ACTOR }),
    ).rejects.toThrow(/rationale/);

    await editParseBlock({
      workspace_id: s.workspace_id,
      block_id: s.ids[0]!,
      text: "Unmet need: comparative OS evidence versus pembrolizumab in first-line NSCLC.",
      kind: "heading",
      heading: "Clinical",
      rationale: "Expand 1L abbreviation",
      actor: ACTOR,
    });
    const blocks = await readParseBlocksWithMeta(s.workspace_id, s.source_file_id);
    const edited = blocks.find((b) => b.id === s.ids[0])!;
    expect(edited.text).toContain("first-line");
    expect(edited.kind).toBe("heading");
    expect(edited.heading).toBe("Clinical");
    expect(edited.provenance.human).toBe(true);
    expect(edited.provenance.origin).toBe("llm");
    expect(edited.provenance.original_text).toBe(AI_TEXTS[0]);
    expect(edited.provenance.edited_by).toBe(ACTOR.name);

    const edits = await listParseBlockEdits(s.workspace_id, s.source_file_id);
    expect(edits.map((e) => e.field).sort()).toEqual(["heading", "kind", "text"]);
    expect(edits.every((e) => e.rationale === "Expand 1L abbreviation")).toBe(true);
  });

  it("refuses a text edit or delete that would orphan a cited quote (409 via API)", async () => {
    const s = await seed("guard");
    await cite(s.workspace_id, s.source_file_id, s.ids[1]!, "real-world persistence data", "gap_1");
    await expect(
      editParseBlock({
        workspace_id: s.workspace_id,
        block_id: s.ids[1]!,
        text: "Payers want long-term data.",
        rationale: "Shorten",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ProvenanceConflictError);

    const res = await post({
      action: "delete",
      workspace_id: s.workspace_id,
      block_id: s.ids[1],
      rationale: "Noise",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { orphaned_claims: string[] };
    expect(body.orphaned_claims).toEqual(["gap_1"]);

    // An edit that keeps the quote is allowed.
    await editParseBlock({
      workspace_id: s.workspace_id,
      block_id: s.ids[1]!,
      text: "Payers in EU5 and the UK ask for real-world persistence data beyond 12 months.",
      rationale: "Add UK",
      actor: ACTOR,
    });

    const ok = await post({ action: "delete", workspace_id: s.workspace_id, block_id: s.ids[2], rationale: "Out of scope" });
    expect(ok.status).toBe(200);
    const left = await readParseBlocks(s.workspace_id, s.source_file_id);
    expect(left.map((b) => b.index)).toEqual([0, 1]);
  });

  it("split re-points provenance to the half that holds the quote; merge keeps quotes", async () => {
    const s = await seed("split");
    await cite(s.workspace_id, s.source_file_id, s.ids[0]!, "versus pembrolizumab", "gap_2");
    const split = await splitParseBlock({
      workspace_id: s.workspace_id,
      block_id: s.ids[0]!,
      at_text: "comparative",
      rationale: "Label and need are separate",
      actor: ACTOR,
    });
    let blocks = await readParseBlocksWithMeta(s.workspace_id, s.source_file_id);
    expect(blocks.map((b) => b.text).slice(0, 2)).toEqual([
      "Unmet need:",
      "comparative OS evidence versus pembrolizumab in 1L NSCLC.",
    ]);
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    const [prov] = await accuracyDb()
      .select()
      .from(t.accuracyProvenance)
      .where(and(eq(t.accuracyProvenance.claim_id, "gap_2"), eq(t.accuracyProvenance.workspace_id, s.workspace_id)));
    expect(prov!.block_id).toBe(split.second_id);
    expect(blocks[1]!.provenance.origin).toBe("human");
    expect(blocks[1]!.provenance.cited_by).toEqual(["gap_2"]);

    // A split straddling the quote is refused.
    await expect(
      splitParseBlock({
        workspace_id: s.workspace_id,
        block_id: split.second_id,
        at_text: "pembrolizumab",
        rationale: "Try",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ProvenanceConflictError);

    await mergeParseBlocks({ workspace_id: s.workspace_id, block_id: s.ids[0]!, rationale: "Undo split", actor: ACTOR });
    blocks = await readParseBlocksWithMeta(s.workspace_id, s.source_file_id);
    expect(blocks).toHaveLength(3);
    const [prov2] = await accuracyDb()
      .select()
      .from(t.accuracyProvenance)
      .where(and(eq(t.accuracyProvenance.claim_id, "gap_2"), eq(t.accuracyProvenance.workspace_id, s.workspace_id)));
    expect(prov2!.block_id).toBe(s.ids[0]);
    expect(blocks[0]!.text).toContain("versus pembrolizumab");
  });

  it("adds a block by hand at a position, labelled human", async () => {
    const s = await seed("add");
    const row = await addParseBlock({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      after_block_id: s.ids[0],
      text: "KOLs flagged PD-L1 subgroup data as missing.",
      kind: "list_item",
      rationale: "Heard in the interview, not in the deck",
      actor: ACTOR,
    });
    const blocks = await readParseBlocksWithMeta(s.workspace_id, s.source_file_id);
    expect(blocks.map((b) => b.id)).toEqual([s.ids[0], row.id, s.ids[1], s.ids[2]]);
    expect(blocks[1]!.parser).toBe("human");
    expect(blocks[1]!.provenance.origin).toBe("human");
  });
});

describe("accuracy re-parse keeps human work", () => {
  it("keeps human-edited, human-added and cited blocks; honours deletions", async () => {
    const s = await seed("reparse");
    await editParseBlock({
      workspace_id: s.workspace_id,
      block_id: s.ids[0]!,
      text: "Unmet need: comparative OS evidence vs pembrolizumab, 1L NSCLC.",
      rationale: "House style",
      actor: ACTOR,
    });
    await cite(s.workspace_id, s.source_file_id, s.ids[1]!, "persistence data", "gap_3");
    await deleteParseBlock({ workspace_id: s.workspace_id, block_id: s.ids[2]!, rationale: "Not a need", actor: ACTOR });
    const added = await addParseBlock({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      text: "Typed by the reviewer.",
      rationale: "Missing context",
      actor: ACTOR,
    });

    // The model parses the same file again and returns the original blocks plus one new one.
    const again = [...AI_TEXTS, "New slide: HTA timelines for Germany."].map((text, index) => ({
      id: `${s.source_file_id}-B${String(index + 1).padStart(3, "0")}`,
      source_file_id: s.source_file_id,
      index,
      kind: "prose" as const,
      heading: null,
      text,
    }));
    const result = await persistParseBlocksDetailed({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      parser: "llm",
      blocks: again,
    });
    expect(result).toMatchObject({ inserted: 1, kept_human: 2, kept_cited: 1, skipped_duplicates: 3 });
    const blocks = await readParseBlocks(s.workspace_id, s.source_file_id);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain("Unmet need: comparative OS evidence vs pembrolizumab, 1L NSCLC.");
    expect(texts).not.toContain(AI_TEXTS[0]);
    expect(texts).not.toContain(AI_TEXTS[2]);
    expect(texts).toContain(AI_TEXTS[1]);
    expect(texts).toContain("New slide: HTA timelines for Germany.");
    expect(blocks.map((b) => b.id)).toContain(added.id);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(blocks.map((b) => b.index)).toEqual(blocks.map((_, i) => i));
  });

  it("a full parse-module re-run on the same source keeps a human block", async () => {
    const { workspace_id, org_id, source_file_id } = await seed("module");
    const run = () =>
      runAccuracyModule<{ block_count: number; kept_human_blocks: number }>({
        call_kind: "parse",
        agent_role: "proposer",
        input: {
          workspace_id,
          source_file_id,
          filename: "notes.txt",
          mime: "text/plain",
          content_base64: Buffer.from("First paragraph of notes.\n\nSecond paragraph of notes.").toString("base64"),
        },
        actor: { name: "Source upload", function: "medical_affairs" },
        org_id,
        workspace_id,
      });
    await addParseBlock({
      workspace_id,
      source_file_id,
      text: "Human note that must survive.",
      rationale: "Reviewer note",
      actor: ACTOR,
    });
    const result = await run();
    expect(result.output.kept_human_blocks).toBe(1);
    const texts = (await readParseBlocks(workspace_id, source_file_id)).map((b) => b.text);
    expect(texts).toContain("Human note that must survive.");
  });
});

describe("accuracy dropped noise and stakeholder override", () => {
  it("restores a dropped unit as a human block, once", async () => {
    const s = await seed("dropped");
    await persistDroppedUnits({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      units: [{ location: "Slide 9", reason: "Footer", text: "Data on file: OS HR 0.71 (95% CI 0.6-0.8)" }],
    });
    const [unit] = await listDroppedUnits(s.workspace_id, s.source_file_id);
    const row = await restoreDroppedUnit({
      workspace_id: s.workspace_id,
      dropped_id: unit!.id,
      rationale: "This footer is actually a key result",
      actor: ACTOR,
    });
    expect(row.text).toBe("Data on file: OS HR 0.71 (95% CI 0.6-0.8)");
    expect(row.heading).toBe("Slide 9");
    await expect(
      restoreDroppedUnit({ workspace_id: s.workspace_id, dropped_id: unit!.id, rationale: "again", actor: ACTOR }),
    ).rejects.toThrow(/Already restored/);
    // A re-parse that drops the same unit again does not list it as restorable twice.
    await persistDroppedUnits({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      units: [{ location: "Slide 9", reason: "Footer", text: "Data on file: OS HR 0.71 (95% CI 0.6-0.8)" }],
    });
    expect(await listDroppedUnits(s.workspace_id, s.source_file_id)).toHaveLength(1);
  });

  it("stores the model's stakeholder rationale; a human override wins and survives a re-run", async () => {
    const s = await seed("stakeholder");
    await recordLlmStakeholder({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      stakeholder_function: "commercial",
      rationale: "Mentions launch sequencing.",
    });
    expect((await readSourceStakeholder(s.workspace_id, s.source_file_id)).set_by).toBe("llm");
    await setSourceStakeholder({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      stakeholder_function: "heor",
      rationale: "It is the HEOR team's model memo",
      actor: ACTOR,
    });
    await recordLlmStakeholder({
      workspace_id: s.workspace_id,
      source_file_id: s.source_file_id,
      stakeholder_function: "marketing",
      rationale: "Re-run guess.",
    });
    const view = await readSourceStakeholder(s.workspace_id, s.source_file_id);
    expect(view).toMatchObject({
      stakeholder_function: "heor",
      set_by: "human",
      llm_function: "marketing",
      llm_rationale: "Re-run guess.",
      override_by: ACTOR.name,
    });
    const res = await blocksGet(
      new Request(
        `http://localhost/api/accuracy/sources/blocks?workspace_id=${s.workspace_id}&source_file_id=${s.source_file_id}`,
      ),
    );
    const body = (await res.json()) as { stakeholder: { stakeholder_function: string }; edits: { field: string }[] };
    expect(body.stakeholder.stakeholder_function).toBe("heor");
    expect(body.edits.some((e) => e.field === "stakeholder_function")).toBe(true);
  });
});

describe("accuracy manual source entry (no AI)", () => {
  it("stores typed blocks as human-entered via the API", async () => {
    await ensureAccuracySchema();
    const org_id = await createOrganization(`org-mb-manual-${Date.now()}`);
    const workspace_id = await createWorkspace({ org_id, name: "MB manual", slug: `mb-manual-${Date.now()}` });
    const bad = await post({ action: "manual_source", workspace_id, blocks: [{ text: "x" }], rationale: "" });
    expect(bad.status).toBe(400);
    const res = await post({
      action: "manual_source",
      workspace_id,
      filename: "kol-call-notes.txt",
      stakeholder_function: "medical_affairs",
      blocks: [
        { text: "KOL call notes", kind: "heading" },
        { text: "Needs OS data in elderly patients.", heading: "KOL call notes" },
      ],
      rationale: "Typed from my call notes",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source_file_id: string; block_ids: string[] };
    const blocks = await readParseBlocksWithMeta(workspace_id, body.source_file_id);
    expect(blocks.map((b) => b.text)).toEqual(["KOL call notes", "Needs OS data in elderly patients."]);
    expect(blocks.every((b) => b.parser === "human" && b.provenance.origin === "human" && b.provenance.human)).toBe(true);
    expect((await readSourceStakeholder(workspace_id, body.source_file_id)).set_by).toBe("human");
  });
});
