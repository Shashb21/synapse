import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Route handlers read the session cookie; outside a request scope, act as the demo typed actor.
vi.mock("@/modules/auth/request", () => ({
  requestIdentity: async (body?: Record<string, unknown>) => ({
    actor: { name: String(body?.actor_name ?? "Demo"), function: String(body?.actor_function ?? "medical_affairs") },
    role: "medical_affairs",
    signed_in: false,
    demo: true,
  }),
}));
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform, db } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import { loadState, commitExtractedRecords, editNeed, persistSourceAndBlocks, resetDemoSetup } from "@/lib/iegp/store";
import * as t from "@/lib/iegp/schema";
import { GET as blocksGet, POST as blocksPost } from "@/app/api/sources/blocks/route";
import {
  SourceQuoteConflictError,
  addSourceBlock,
  deleteSourceBlock,
  editSourceBlock,
  listDroppedSourceUnits,
  listSourceBlocks,
  mergeSourceBlocks,
  persistDroppedSourceUnits,
  readSourceStakeholder,
  reparseSourceBlocks,
  recordLlmSourceStakeholder,
  restoreDroppedSourceUnit,
  setSourceStakeholder,
  splitSourceBlock,
} from "@/lib/iegp/source-blocks";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import type { ParseOutput } from "@/modules/stages/s1-parse/module";
import type { UploadOutput } from "@/modules/stages/s0-upload/module";

const ACTOR = { name: "Iris Lead", function: "evidence_lead" as const };

async function source(label: string) {
  return persistSourceAndBlocks({
    title: `Notes ${label}`,
    source_type: "stakeholder_interview",
    stakeholder_function: "medical_affairs",
    text: "",
    sections: [
      { heading: "Needs", text: "Payers want OS data versus docetaxel in 2L NSCLC.", location: "p.1" },
      { heading: "Needs", text: "KOLs ask about PD-L1 low patients.", location: "p.1" },
      { heading: "Plans", text: "A chart review is planned in 2027.", location: "p.2" },
    ],
  });
}

async function citeNeed(id: string, source_id: string, quote: string) {
  const state = await loadState();
  await db().insert(t.needs).values({
    id,
    statement: "Need",
    domain: "clinical",
    stakeholder: "medical_affairs",
    objective_id: state.objectives[0]?.id ?? "OBJ-1",
    decision_supported: "",
    geography: "",
    population: "",
    intervention: "",
    comparator: "",
    outcome: "",
    timing: "",
    source_id,
    source_quote: quote,
    confidence: null,
    status: "candidate",
    lock: {},
  });
}

function post(body: Record<string, unknown>) {
  return blocksPost(
    new Request("http://localhost/api/sources/blocks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
}

describe("S1 source blocks: human edit, add, split, merge, delete", () => {
  beforeAll(async () => {
    await resetDemoSetup();
  }, 60_000);

  it("edits a block with rationale, keeps the model's original and writes an edit record", async () => {
    const started = new Date().toISOString();
    const { source_id, blocks } = await source("edit");
    await expect(editSourceBlock({ block_id: blocks[0]!.id, text: "x", rationale: "", actor: ACTOR })).rejects.toThrow(
      /rationale/,
    );
    await editSourceBlock({
      block_id: blocks[0]!.id,
      text: "Payers want OS data versus docetaxel in second-line NSCLC.",
      heading: "Payer needs",
      rationale: "Spell out 2L",
      actor: ACTOR,
    });
    const view = (await listSourceBlocks(source_id))[0]!;
    expect(view).toMatchObject({ human: true, origin: "llm", heading: "Payer needs", edited_by: ACTOR.name });
    expect(view.original_text).toBe("Payers want OS data versus docetaxel in 2L NSCLC.");
    const edits = (await listEdits({ entity_id: blocks[0]!.id })).filter((e) => e.at >= started);
    expect(edits.map((e) => e.field).sort()).toEqual(["heading", "text"]);
    expect(edits[0]!.rationale).toBe("Spell out 2L");
    // The workspace audit outlives resets (KAN-89): count only this test's rows.
    const audit = (await loadState()).audit.filter((a) => a.entity_id === blocks[0]!.id && a.at >= started);
    expect(audit.length).toBe(2);
  });

  it("refuses edits and deletes that would orphan a need's quote (409 via API)", async () => {
    const { source_id, blocks } = await source("guard");
    await citeNeed(`NEED-G-${Date.now()}`, source_id, "PD-L1 low patients");
    await expect(
      editSourceBlock({ block_id: blocks[1]!.id, text: "KOLs ask about biomarkers.", rationale: "Shorter", actor: ACTOR }),
    ).rejects.toBeInstanceOf(SourceQuoteConflictError);
    const res = await post({ action: "delete", block_id: blocks[1]!.id, rationale: "noise" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { orphaned_needs: string[] }).orphaned_needs).toHaveLength(1);
    // Delete of an uncited block works and is ordered out.
    await deleteSourceBlock({ block_id: blocks[2]!.id, rationale: "Not a need", actor: ACTOR });
    expect((await listSourceBlocks(source_id)).map((b) => b.id)).toEqual([blocks[0]!.id, blocks[1]!.id]);
  });

  it("protects the identified model need block even when its quote is repeated", async () => {
    const { source_id, blocks } = await source("repeated need quote");
    const quote = blocks[0]!.text;
    const duplicate = await addSourceBlock({ source_id, text: quote, after_block_id: null, rationale: "Record a repeat", actor: ACTOR });
    const id = `NEED-S2-${source_id}`;
    await citeNeed(id, source_id, quote);
    await db().update(t.needs).set({ block_id: blocks[0]!.id, run_id: "fictional-s2-run" }).where(eq(t.needs.id, id));
    const human = { actor_name: ACTOR.name, actor_function: ACTOR.function, rationale: "Review the quote" };
    await expect(editNeed({ need_id: id, source_quote: "An unrelated sentence.", ...human })).rejects.toThrow(/quote.*source block/i);
    await editNeed({ need_id: id, source_quote: "OS data versus docetaxel", ...human });
    await expect(deleteSourceBlock({ block_id: blocks[0]!.id, rationale: "Remove duplicate", actor: ACTOR })).rejects.toBeInstanceOf(SourceQuoteConflictError);
    await deleteSourceBlock({ block_id: duplicate.id, rationale: "Remove uncited duplicate", actor: ACTOR });
    expect((await loadState()).needs.find((row) => row.id === id)?.block_id).toBe(blocks[0]!.id);
  });

  it("keeps existing tactic citations through source edits and reparse", async () => {
    const { source_id, blocks } = await source("legacy tactic quote");
    const quote = blocks[2]!.text;
    await commitExtractedRecords({
      source_id, title: "Notes legacy tactic quote", stakeholder_function: ACTOR.function,
      actor_name: ACTOR.name, actor_function: ACTOR.function, needs: [], gaps: [],
      tactics: [{ id: "study", name: "Chart review", type: "rwe_study", status: "planned",
        evidence_question: "What does routine care show?", source_id, source_quote: quote }],
    });
    await expect(editSourceBlock({ block_id: blocks[2]!.id, text: "The interview ended.", rationale: "Shorter notes", actor: ACTOR })).rejects.toBeInstanceOf(SourceQuoteConflictError);
    const reparsed = await reparseSourceBlocks({ source_id, sections: [{ heading: "Wrap-up", text: "The interview ended.", location: "p.3" }] });
    expect(reparsed.blocks.find((row) => row.id === blocks[2]!.id)).toMatchObject({ text: quote });
  });

  it.each(["id", "title"] as const)("protects a historical tactic's primary passage identified by source %s alongside a later reference", async identity => {
    const { source_id, blocks } = await source(`legacy primary ${identity}`);
    const [primary, secondary] = blocks;
    const state = await loadState();
    const storedSource = state.sources.find(row => row.id === source_id)!;
    const result = await commitExtractedRecords({
      source_id, title: storedSource.title, stakeholder_function: ACTOR.function,
      actor_name: ACTOR.name, actor_function: ACTOR.function, needs: [], gaps: [],
      tactics: [{ id: "study", name: "Fictional primary activity", type: "rwe_study", status: "planned",
        evidence_question: "What does routine care show?", source_id, source_quote: "" }],
    });
    const tacticId = result.tactic_ids[0]!;
    await db().update(t.tactics).set({ source_quote: primary!.text, data_source: storedSource[identity] }).where(eq(t.tactics.id, tacticId));
    const { attachTacticSource } = await import("@/modules/stages/s3-tactic-extract/suggestions");
    await attachTacticSource({ tactic_id: tacticId, source_id, source_quote: secondary!.text, block_id: secondary!.id });

    await expect(editSourceBlock({ block_id: primary!.id, text: "A different passage.", rationale: "Edit main source", actor: ACTOR }))
      .rejects.toBeInstanceOf(SourceQuoteConflictError);
    const reparsed = await reparseSourceBlocks({ source_id, sections: [{ heading: "Other", text: "A different passage.", location: "p.3" }] });
    expect(reparsed.blocks.map(row => row.id)).toEqual(expect.arrayContaining([primary!.id, secondary!.id]));
  });

  it("splits, merges and adds in reading order, labelling human blocks", async () => {
    const { source_id, blocks } = await source("split");
    const split = await splitSourceBlock({
      block_id: blocks[0]!.id,
      at_text: "versus docetaxel",
      rationale: "Two ideas",
      actor: ACTOR,
    });
    let view = await listSourceBlocks(source_id);
    expect(view.map((b) => b.id)).toEqual([blocks[0]!.id, split.second_id, blocks[1]!.id, blocks[2]!.id]);
    expect(view[1]).toMatchObject({ origin: "human", text: "versus docetaxel in 2L NSCLC." });
    await mergeSourceBlocks({ block_id: blocks[0]!.id, rationale: "Undo", actor: ACTOR });
    const added = await addSourceBlock({
      source_id,
      after_block_id: null,
      text: "Context typed by the lead.",
      rationale: "Missing context",
      actor: ACTOR,
    });
    view = await listSourceBlocks(source_id);
    expect(view.map((b) => b.id)).toEqual([added.id, blocks[0]!.id, blocks[1]!.id, blocks[2]!.id]);
    expect(view[1]!.text).toBe("Payers want OS data\n\nversus docetaxel in 2L NSCLC.");
  });

  it("restores a dropped noise unit and sets the stakeholder over the model's guess", async () => {
    const { source_id } = await source("drop");
    await persistDroppedSourceUnits(source_id, [{ location: "p.9", reason: "Footer", text: "OS HR 0.71 on file" }]);
    const [unit] = await listDroppedSourceUnits(source_id);
    const row = await restoreDroppedSourceUnit({ dropped_id: unit!.id, rationale: "Key result", actor: ACTOR });
    expect(row.location).toBe("p.9");
    expect((await listSourceBlocks(source_id)).at(-1)).toMatchObject({ id: row.id, origin: "human" });

    await recordLlmSourceStakeholder({ source_id, stakeholder_function: "commercial", rationale: "Talks about launch." });
    await setSourceStakeholder({ source_id, stakeholder_function: "hta", rationale: "HTA advisory notes", actor: ACTOR });
    await recordLlmSourceStakeholder({ source_id, stakeholder_function: "marketing", rationale: "Second guess." });
    const view = await readSourceStakeholder(source_id);
    expect(view).toMatchObject({ stakeholder_function: "hta", set_by: "human", llm_function: "marketing", llm_rationale: "Second guess." });
    const state = await loadState();
    expect(state.sources.find((s) => s.id === source_id)!.stakeholder_function).toBe("hta");
  });

  it("creates a typed source with human-entered blocks via the API, no AI", async () => {
    const res = await post({
      action: "manual_source",
      title: "Advisory board notes",
      source_type: "advisory_board",
      stakeholder_function: "medical_affairs",
      blocks: [{ text: "Board wants PFS in elderly." }, { text: "Board wants QoL data.", heading: "QoL" }],
      rationale: "Typed from my notes",
    });
    expect(res.status).toBe(200);
    const { source_id } = (await res.json()) as { source_id: string };
    const view = await listSourceBlocks(source_id);
    expect(view.map((b) => b.text)).toEqual(["Board wants PFS in elderly.", "Board wants QoL data."]);
    expect(view.every((b) => b.origin === "human" && b.human && b.location === "Typed by hand")).toBe(true);
    const get = await blocksGet(new Request(`http://localhost/api/sources/blocks?source_id=${source_id}`));
    const body = (await get.json()) as { stakeholder: { set_by: string }; edits: unknown[] };
    expect(body.stakeholder.set_by).toBe("human");
    expect(body.edits.length).toBeGreaterThan(0);
  });
});

describe("S1 re-parse keeps human-edited blocks", () => {
  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform(["source_files", "parsed_documents"]);
  }, 60_000);

  it("re-parsing a parsed file updates its source in place and keeps human work", async () => {
    const text = "Payers need OS data.\n\nKOLs want PD-L1 subgroups.\n\nChart review planned.";
    const upload = await runStage<UploadOutput>({
      stage: "S0",
      input: {
        files: [
          {
            filename: "reparse.txt",
            title: "Reparse notes",
            source_type: "stakeholder_interview",
            stakeholder_function: "heor",
            text,
          },
        ],
      },
      actor: ACTOR,
      role: "medical_affairs",
    });
    const file_id = upload.output.files[0]!.id;
    const first = await runStage<ParseOutput>({ stage: "S1", input: { file_ids: [file_id] }, actor: ACTOR, role: "medical_affairs" });
    const source_id = first.output.documents[0]!.source_id;
    const before = await listSourceBlocks(source_id);
    expect(before.length).toBeGreaterThan(0);

    const target = before[0]!;
    await editSourceBlock({ block_id: target.id, text: `${target.text} (edited)`, rationale: "Clarify", actor: ACTOR });
    const added = await addSourceBlock({ source_id, text: "Human-only note.", rationale: "Add note", actor: ACTOR });
    await setSourceStakeholder({ source_id, stakeholder_function: "hta", rationale: "Right owner", actor: ACTOR });

    const second = await runStage<ParseOutput>({ stage: "S1", input: { file_ids: [file_id] }, actor: ACTOR, role: "medical_affairs" });
    expect(second.output.failures).toHaveLength(0);
    expect(second.output.documents[0]!.source_id).toBe(source_id);
    const state = await loadState();
    expect(state.sources.filter((s) => s.title === "Reparse notes")).toHaveLength(1);
    expect(state.sources.find((s) => s.id === source_id)!.stakeholder_function).toBe("hta");

    const after = await listSourceBlocks(source_id);
    const texts = after.map((b) => b.text);
    expect(texts).toContain(`${target.text} (edited)`);
    expect(texts).not.toContain(target.text);
    expect(after.find((b) => b.id === added.id)?.text).toBe("Human-only note.");
    expect(new Set(after.map((b) => b.id)).size).toBe(after.length);
    expect((await listSourceFiles()).find((f) => f.id === file_id)!.source_id).toBe(source_id);
  }, 60_000);
});
