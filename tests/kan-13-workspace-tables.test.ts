import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
// Deliberately no `import "@/modules"`: bootstrap must not depend on which
// stage modules a caller happened to load first.
import { ensureCurrentSchemaTables, ensureWorkspaceSchema, onWorkspaceBootstrap, sharedDb } from "@/lib/iegp/db";
import { persistSourceAndBlocks, resetSeed } from "@/lib/iegp/store";
import {
  addSourceBlock,
  createManualSource,
  deleteSourceBlock,
  editSourceBlock,
  listDroppedSourceUnits,
  listSourceBlocks,
  persistDroppedSourceUnits,
  readSourceStakeholder,
  setSourceStakeholder,
} from "@/lib/iegp/source-blocks";
import { getRoomState, listRoomNotes, saveRoomNote } from "@/lib/room/store";
import { FIRST_SLIDE_ID } from "@/lib/room/slides";
import { getWalkthrough } from "@/lib/iegp/walkthrough";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { createWorkspace, getWorkspace, withWorkspace } from "@/modules/workspaces/store";

const ACTOR = { name: "KAN-13 Tester", function: "evidence_lead" as const };
const unique = () => Math.random().toString(36).slice(2, 8);
const rawSchemas: string[] = [];

const EXPECTED_TABLES = [
  // core IEGP
  "sources",
  "source_blocks",
  "gaps",
  // source-block side tables (REQ-SRC-004)
  "source_block_meta",
  "source_dropped_units",
  "source_stakeholder_meta",
  // room
  "room_notes",
  "room_presenter",
  // walkthrough
  "walkthrough_progress",
  // kernel workspace tables
  "module_runs",
  "edit_records",
  "hillclimb_signals",
  "priority_axes",
  "priority_placements",
  "ideation_proposals",
  "timeline_activities",
  "iegp_plans",
  // stage module tables
  "source_files",
  "parsed_documents",
  "gap_candidates",
  "tactic_candidates",
  "mapping_candidates",
];

async function tablesIn(schema: string): Promise<Set<string>> {
  const rows = (await sharedDb().execute(
    sql`select table_name from information_schema.tables where table_schema = ${schema}`,
  )) as unknown as { table_name: string }[];
  return new Set(rows.map((row) => row.table_name));
}

async function columnsOf(schema: string, table: string): Promise<Set<string>> {
  const rows = (await sharedDb().execute(
    sql`select column_name from information_schema.columns where table_schema = ${schema} and table_name = ${table}`,
  )) as unknown as { column_name: string }[];
  return new Set(rows.map((row) => row.column_name));
}

/** Every human block operation, in whatever workspace is current. */
async function exerciseSourceBlocks(label: string) {
  const parsed = await persistSourceAndBlocks({
    title: `KAN-13 ${label}`,
    source_type: "stakeholder_interview",
    stakeholder_function: "medical_affairs",
    text: "",
    sections: [
      { heading: "Needs", text: `Payers in ${label} want OS data versus docetaxel.`, location: "p.1" },
      { heading: "Plans", text: `A chart review in ${label} is planned in 2027.`, location: "p.2" },
    ],
  });
  const [first, second] = parsed.blocks;
  await editSourceBlock({
    block_id: first!.id,
    text: `Payers in ${label} want OS and PFS data versus docetaxel.`,
    rationale: "Model dropped PFS",
    actor: ACTOR,
  });
  const added = await addSourceBlock({
    source_id: parsed.source_id,
    text: `Added by hand in ${label}.`,
    rationale: "Missing from the parse",
    actor: ACTOR,
  });
  await deleteSourceBlock({ block_id: second!.id, rationale: "Duplicate of an earlier note", actor: ACTOR });
  await persistDroppedSourceUnits(parsed.source_id, [{ location: "p.3", reason: "boilerplate", text: `Footer ${label}` }]);

  const blocks = await listSourceBlocks(parsed.source_id);
  expect(blocks.map((b) => b.text)).toEqual([
    `Payers in ${label} want OS and PFS data versus docetaxel.`,
    `Added by hand in ${label}.`,
  ]);
  expect(blocks.find((b) => b.id === added.id)?.human).toBe(true);
  expect((await listDroppedSourceUnits(parsed.source_id)).map((u) => u.text)).toEqual([`Footer ${label}`]);

  await setSourceStakeholder({
    source_id: parsed.source_id,
    stakeholder_function: "market_access",
    rationale: "Interviewee is a payer",
    actor: ACTOR,
  });
  expect((await readSourceStakeholder(parsed.source_id)).override_function).toBe("market_access");

  const manual = await createManualSource({
    title: `Typed ${label}`,
    source_type: "stakeholder_interview",
    stakeholder_function: "medical_affairs",
    blocks: [{ text: `Typed note from ${label}.` }],
    rationale: "Notes from a call",
    actor: ACTOR,
  });
  const manualBlocks = await listSourceBlocks(manual.source_id);
  expect(manualBlocks.map((b) => b.text)).toEqual([`Typed note from ${label}.`]);
  expect(manualBlocks[0]!.origin).toBe("human");
  return { parsed, manual };
}

afterAll(async () => {
  for (const name of rawSchemas) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
});

describe("KAN-13: per-workspace tables", () => {
  it("edits source blocks in Default and in two workspaces, in any order", async () => {
    const owner = `owner-${unique()}@example.com`;
    const a = await createWorkspace({ name: `KAN-13 A ${unique()}`, owner });
    const b = await createWorkspace({ name: `KAN-13 B ${unique()}`, owner });

    // Default first: before the fix, this cached "done" for the whole process.
    await exerciseSourceBlocks("Default");
    const inA = await withWorkspace(a.id, async () => {
      await resetSeed();
      return exerciseSourceBlocks("A");
    });
    const inB = await withWorkspace(b.id, async () => {
      await resetSeed();
      return exerciseSourceBlocks("B");
    });

    // Each workspace sees only its own human edits.
    const aStakeholder = await withWorkspace(a.id, () => readSourceStakeholder(inA.parsed.source_id));
    expect(aStakeholder.override_function).toBe("market_access");
    const bTexts = await withWorkspace(b.id, async () =>
      (await listSourceBlocks(inB.manual.source_id)).map((x) => x.text),
    );
    expect(bTexts).toEqual(["Typed note from B."]);
    const aTexts = await withWorkspace(a.id, async () =>
      (await listSourceBlocks(inA.manual.source_id)).map((x) => x.text),
    );
    expect(aTexts.join(" ")).not.toContain("from B");
  }, 120_000);

  it("bootstraps every workspace table in a fresh schema", async () => {
    const ws = await createWorkspace({ name: `KAN-13 fresh ${unique()}`, owner: `owner-${unique()}@example.com` });
    const found = await getWorkspace(ws.id);
    const tables = await tablesIn(found!.schema_name);
    const missing = EXPECTED_TABLES.filter((name) => !tables.has(name));
    expect(missing).toEqual([]);
    expect((await columnsOf(found!.schema_name, "source_block_meta")).has("source_generation")).toBe(true);
    expect((await columnsOf(found!.schema_name, "tactic_candidates")).has("duplicate_of")).toBe(true);

    // Room and walkthrough work straight away in the new workspace.
    await withWorkspace(ws.id, async () => {
      await saveRoomNote(FIRST_SLIDE_ID, "Open with the evidence gaps.");
      expect((await listRoomNotes())[FIRST_SLIDE_ID]).toBe("Open with the evidence gaps.");
      expect((await getRoomState()).slide_id).toBe(FIRST_SLIDE_ID);
      await getWalkthrough("someone@example.com");
      // Reset clears module tables without swallowing errors.
      await resetWorkspaceModules();
    });
  }, 60_000);

  it("the Default schema has every workspace table too", async () => {
    await ensureCurrentSchemaTables();
    const tables = await tablesIn("public");
    expect(EXPECTED_TABLES.filter((name) => !tables.has(name))).toEqual([]);
    await resetWorkspaceModules();
  });

  it("retries a bootstrap that failed instead of caching the failure", async () => {
    const name = `ws_kan13_${unique()}`;
    rawSchemas.push(name);
    let calls = 0;
    const remove = onWorkspaceBootstrap(async () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated DDL failure");
    });
    try {
      await expect(ensureWorkspaceSchema(name)).rejects.toThrow("simulated DDL failure");
      await expect(ensureWorkspaceSchema(name)).resolves.toBeUndefined();
      expect(calls).toBe(2);
      // Succeeded once: cached from now on.
      await ensureWorkspaceSchema(name);
      expect(calls).toBe(2);
    } finally {
      remove();
    }
    const tables = await tablesIn(name);
    expect(EXPECTED_TABLES.filter((t) => !tables.has(t))).toEqual([]);
  }, 60_000);
});
