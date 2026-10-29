/** Behavioral extraction regressions: real API, modules and PostgreSQL; only model completion is fake. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";

const priorPlatformPool = vi.hoisted(() => {
  // Accuracy uses the platform pool. A single test connection would queue the
  // edit behind the paused save before either could contend for our source lock.
  const prior = process.env.DATABASE_PLATFORM_POOL_MAX;
  process.env.DATABASE_PLATFORM_POOL_MAX = "4";
  return prior;
});
afterAll(() => {
  if (priorPlatformPool === undefined) delete process.env.DATABASE_PLATFORM_POOL_MAX;
  else process.env.DATABASE_PLATFORM_POOL_MAX = priorPlatformPool;
});

const provider = vi.hoisted(() => ({
  // The argument declares the fake transport's signature for each test's reply.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reply: (_args: { user: string; purpose: string }): unknown => ({ gaps: [], tactics: [] }),
  calls: [] as string[],
}));
vi.mock("@/modules/auth/owner", () => ({
  ownerGate: async () => null,
  ownerAccess: async () => ({ owner: true, actor: { name: "Owner", function: "medical_affairs" } }),
}));
vi.mock("@/accuracy/kernel/routing", async (original) => ({
  ...await original<typeof import("@/accuracy/kernel/routing")>(),
  accuracyCompletionFor: () => async (args: { user: string; purpose: string }) => {
    provider.calls.push(args.purpose);
    return { raw: JSON.stringify(await provider.reply(args)), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  },
}));
import { POST } from "@/app/api/accuracy/extract/route";
import { applyClaimValidation, claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { updateClaim } from "@/accuracy/store/claim-edit";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { createManualSource, editParseBlock, persistParseBlocks, ProvenanceConflictError } from "@/accuracy/store/parse-store";
import { completedExtractKinds, prepareExtractPage, saveExtractBatch } from "@/accuracy/store/extract-batch-store";
import { insertSourceFile, listSourceFiles } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace, deleteWorkspace, getWorkspace } from "@/accuracy/store/tenant";
import { accuracyParseBlocks } from "@/accuracy/store/schema";

const actor = { name: "Owner", function: "medical_affairs" as const };
const priorStub = process.env.SYNAPSE_TEST_STUB_LLM;
const priorKey = process.env.XAI_API_KEY;
beforeEach(() => {
  process.env.SYNAPSE_TEST_STUB_LLM = "0";
  process.env.XAI_API_KEY = "test-only-fake-key";
  provider.calls = [];
  provider.reply = () => ({ gaps: [], tactics: [] });
});
afterEach(() => {
  process.env.SYNAPSE_TEST_STUB_LLM = priorStub;
  if (priorKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = priorKey;
});

async function fixture(count = 81) {
  await ensureAccuracySchema();
  const label = crypto.randomUUID();
  const org_id = await createOrganization(`Continuation ${label}`);
  const workspace_id = await createWorkspace({ org_id, name: label, slug: label });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "81-blocks.txt", mime: "text/plain", checksum: label });
  const blocks = Array.from({ length: count }, (_, index) => ({
    id: `${source.id}-B${index}`, source_file_id: source.id, index,
    kind: "prose" as const, heading: null, text: index === 80 ? "Last-only evidence need" : `Evidence text ${index}`,
  }));
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local", blocks });
  return { workspace_id, source_file_id: source.id, blocks };
}

async function extract(body: Record<string, unknown>) {
  const response = await POST(new Request("http://localhost/api/accuracy/extract", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

function gapReply(f: Awaited<ReturnType<typeof fixture>>, index: number, statement = "Need evidence") {
  const block = f.blocks[index];
  return { gaps: [{ statement, external_id: null, provenance: [{ source_file_id: f.source_file_id, block_id: block.id, quote: block.text }] }] };
}

describe("durable source extraction continuation", () => {
  it("serializes a concurrent human edit with quote validation and claim insertion", async () => {
    const f = await fixture(1);
    const page = await prepareExtractPage({ ...f, reference_pack_id: null, kinds: ["need"] });
    // A real database trigger pauses the save after its snapshot check, while
    // an independent connection observes lock waits instead of guessing timing.
    const connection = postgres(process.env.DATABASE_URL!, { max: 2 });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `pause_extract_${suffix}`;
    const triggerName = `pause_extract_${suffix}`;
    const lockId = Number.parseInt(suffix.slice(0, 7), 16);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let save: Promise<number> | undefined;
    let edit: Promise<unknown> | undefined;
    const blocker = connection.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${lockId})`;
      held();
      await released;
    });
    try {
      await holding;
      await connection.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.workspace_id = '${f.workspace_id}' THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`);
      await connection.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON accuracy_claims FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      save = saveExtractBatch({ page, kind: "need", run_id: "concurrent-test", claims: [{
        claim_type: "gap", statement: "Concurrent evidence", status: "draft", metadata: {},
        provenance: [{ source_file_id: f.source_file_id, block_id: f.blocks[0].id, quote: f.blocks[0].text }],
      }] });
      await expect.poll(async () => (await connection`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event = 'advisory'
        and query like '%accuracy_claims%'
      `)[0].count, { timeout: 5_000 }).toBe(1);
      edit = editParseBlock({ workspace_id: f.workspace_id, block_id: f.blocks[0].id,
        text: "Replacement removes the cited quote", rationale: "Human correction", actor });
      // Attach the rejection handler immediately so the expected refusal is handled.
      const edited = edit.then(() => "unexpected-success", (error: unknown) => error);
      await expect.poll(async () => (await connection`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        and query like '%accuracy_source_files%' and pid <> pg_backend_pid()
      `)[0].count, { timeout: 5_000 }).toBeGreaterThan(0);
      release();
      await blocker;
      expect(await save).toBe(1);
      expect(await edited).toBeInstanceOf(ProvenanceConflictError);
      const [claim] = await listClaims(f.workspace_id);
      expect(claim.statement).toBe("Concurrent evidence");
    } finally {
      release();
      await blocker;
      await Promise.allSettled([save, edit]);
      await connection.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON accuracy_claims`);
      await connection.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await connection.end();
    }
  });

  it("publishes no partial manual source when the human audit fails", async () => {
    const f = await fixture(1);
    const connection = postgres(process.env.DATABASE_URL!, { max: 1 });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `reject_manual_${suffix}`;
    const triggerName = `reject_manual_${suffix}`;
    const sourcesBefore = await listSourceFiles(f.workspace_id);
    try {
      await connection.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.workspace_id = '${f.workspace_id}' AND NEW.action = 'override'
        THEN RAISE EXCEPTION 'manual audit unavailable'; END IF; RETURN NEW; END $$`);
      await connection.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON accuracy_parse_block_edits FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(createManualSource({ workspace_id: f.workspace_id, filename: "manual.txt",
        blocks: [{ text: "First manual block" }, { text: "Second manual block" }],
        stakeholder_function: "medical_affairs", rationale: "Typed notes", actor,
      })).rejects.toThrow();
      expect(await listSourceFiles(f.workspace_id)).toEqual(sourcesBefore);
      for (const table of ["accuracy_parse_block_meta", "accuracy_parse_block_edits", "accuracy_source_stakeholder"]) {
        const rows = await connection.unsafe(`SELECT * FROM ${table} WHERE workspace_id = $1`, [f.workspace_id]);
        expect(rows).toHaveLength(0);
      }
      expect((await connection`SELECT * FROM accuracy_parse_blocks WHERE workspace_id = ${f.workspace_id}`)).toHaveLength(1);
    } finally {
      await connection.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON accuracy_parse_block_edits`);
      await connection.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await connection.end();
    }
  });

  it("waits for an in-flight save before atomically deleting its workspace and checkpoints", async () => {
    const f = await fixture(1);
    const page = await prepareExtractPage({ ...f, reference_pack_id: null, kinds: ["need"] });
    const connection = postgres(process.env.DATABASE_URL!, { max: 2 });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `pause_delete_${suffix}`;
    const triggerName = `pause_delete_${suffix}`;
    const lockId = Number.parseInt(suffix.slice(0, 7), 16);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let save: Promise<number> | undefined;
    let deletion: ReturnType<typeof deleteWorkspace> | undefined;
    const blocker = connection.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${lockId})`;
      held();
      await released;
    });
    try {
      await holding;
      await connection.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.workspace_id = '${f.workspace_id}' THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`);
      await connection.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON accuracy_claims FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      save = saveExtractBatch({ page, kind: "need", run_id: "delete-race", claims: [{
        claim_type: "gap", statement: "Concurrent evidence", status: "draft", metadata: {},
        provenance: [{ source_file_id: f.source_file_id, block_id: f.blocks[0].id, quote: f.blocks[0].text }],
      }] });
      await expect.poll(async () => (await connection`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event = 'advisory' and query like '%accuracy_claims%'
      `)[0].count, { timeout: 5_000 }).toBe(1);
      deletion = deleteWorkspace(f.workspace_id);
      await expect.poll(async () => (await connection`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        and query like '%accuracy_source_files%' and pid <> pg_backend_pid()
      `)[0].count, { timeout: 5_000 }).toBeGreaterThan(0);
      // Deletion must wait before removing any of the source's evidence.
      expect((await connection`SELECT * FROM accuracy_parse_blocks WHERE workspace_id = ${f.workspace_id}`)).toHaveLength(1);
      release();
      await blocker;
      expect(await save).toBe(1);
      expect((await deletion).deleted).toMatchObject({ claims: 1, provenance: 1, parse_blocks: 1, source_files: 1, workspace: 1 });
      expect(await getWorkspace(f.workspace_id)).toBeNull();
      for (const table of ["accuracy_extract_batches", "accuracy_claims", "accuracy_provenance", "accuracy_parse_blocks", "accuracy_source_files"]) {
        expect(await connection.unsafe(`SELECT * FROM ${table} WHERE workspace_id = $1`, [f.workspace_id])).toHaveLength(0);
      }
      await expect(saveExtractBatch({ page, kind: "need", run_id: "late-save", claims: [] })).rejects.toThrow(/Unknown source/);
    } finally {
      release();
      await blocker;
      await Promise.allSettled([save, deletion]);
      await connection.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON accuracy_claims`);
      await connection.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await connection.end();
    }
  });

  it("requires parse blocks before extracting an empty source", async () => {
    const f = await fixture(0);
    const result = await extract({ ...f, kinds: ["need"] });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/upload\/re-parse/);
    expect(await listClaims(f.workspace_id)).toHaveLength(0);
  });

  it("reaches an item found only in block 81 and reports partial then complete", async () => {
    const f = await fixture();
    provider.reply = ({ user }) => user.includes("Last-only evidence need") ? gapReply(f, 80, "Last-only need") : { gaps: [] };
    const first = await extract({ ...f, kinds: ["need"] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "partial", blocks_used: 80, blocks_processed: 80, block_count: 81, complete: false });
    expect(await listClaims(f.workspace_id)).toHaveLength(0);
    const last = await extract({ ...f, kinds: ["need"], continuation: first.body.continuation });
    expect(last.body).toMatchObject({ status: "complete", blocks_used: 1, blocks_processed: 81, complete: true, continuation: null });
    expect((await listClaims(f.workspace_id)).map((row) => row.statement)).toEqual(["Last-only need"]);
  });

  it.each([1, 80])("completes %i blocks with empty model output", async (count) => {
    const f = await fixture(count);
    const result = await extract({ ...f, kinds: ["need", "inventory"] });
    expect(result.body).toMatchObject({ ok: true, complete: true, status: "complete", blocks_used: count, blocks_processed: count, continuation: null });
    expect(await listClaims(f.workspace_id)).toHaveLength(0);
  });

  it("rejects malformed, skipped, changed-kind, cross-source and stale continuations", async () => {
    const f = await fixture(161);
    const first = await extract({ ...f, kinds: ["need"] });
    const continuation = first.body.continuation;
    expect(continuation).toBeTruthy();
    for (const invalid of [{ ...continuation, offset: -1 }, { ...continuation, offset: 160 }, { ...continuation, snapshot: "fake" }]) {
      expect((await extract({ ...f, kinds: ["need"], continuation: invalid })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await extract({ ...f, kinds: ["inventory"], continuation })).status).toBe(409);
    const other = await fixture();
    expect((await extract({ ...other, kinds: ["need"], continuation })).status).toBe(409);
    expect((await extract({ workspace_id: other.workspace_id, source_file_id: f.source_file_id, kinds: ["need"], continuation })).status).toBe(404);
    await accuracyDb().update(accuracyParseBlocks).set({ text: "Human changed content" }).where(eq(accuracyParseBlocks.id, f.blocks[80].id));
    const stale = await extract({ ...f, kinds: ["need"], continuation });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/restart/i);
  });

  it("retains durable needs after inventory fails and retries only the unfinished kind", async () => {
    const f = await fixture(1);
    provider.reply = ({ purpose }) => {
      if (purpose.startsWith("inventory")) throw new Error("Provider unavailable");
      return gapReply(f, 0);
    };
    const failed = await extract({ ...f, kinds: ["need", "inventory"] });
    expect(failed.body).toMatchObject({ ok: false, status: "failed", blocks_processed: 0 });
    expect(failed.body.continuation).toBeTruthy();
    expect(await listClaims(f.workspace_id)).toHaveLength(1);
    provider.calls = [];
    provider.reply = () => ({ gaps: [], tactics: [] });
    const retry = await extract({ ...f, kinds: ["need", "inventory"], continuation: failed.body.continuation });
    expect(retry.body).toMatchObject({ ok: true, complete: true, blocks_processed: 1 });
    expect(provider.calls.some((call) => call.startsWith("need_extract"))).toBe(false);
    expect(await listClaims(f.workspace_id)).toHaveLength(1);
  });

  it("retries failed status derivation from saved checkpoints without regeneration or changing human decisions", async () => {
    const f = await fixture(4);
    const page = await prepareExtractPage({ ...f, reference_pack_id: null, kinds: ["need", "inventory"] });
    provider.reply = ({ purpose }) => purpose.startsWith("inventory") ? { tactics: [{
      name: "Registry study", type: "registry", status: "planned", evidence_question: "What is long-term survival?",
      provenance: [{ source_file_id: f.source_file_id, block_id: f.blocks[3].id, quote: f.blocks[3].text }],
    }] } : { gaps: [0, 1, 2].map((index) => gapReply(f, index, `Need ${index}`).gaps[0]) };
    const connection = postgres(process.env.DATABASE_URL!, { max: 1 });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `reject_status_${suffix}`;
    const triggerName = `reject_status_${suffix}`;
    try {
      // Fail the real status store write, after both extraction kinds committed.
      await connection.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.workspace_id = '${f.workspace_id}' AND NEW.metadata ? 'computed_status'
        THEN RAISE EXCEPTION 'status persistence unavailable'; END IF; RETURN NEW; END $$`);
      await connection.unsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON accuracy_claims FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      const failed = await extract({ ...f, kinds: ["need", "inventory"] });
      expect(failed.status).toBe(400);
      expect(failed.body).toMatchObject({ ok: false, status: "failed", complete: false, blocks_processed: 4,
        continuation: { offset: 0, kinds: ["inventory", "need"] } });
      expect(await completedExtractKinds(page)).toEqual(new Set(["need", "inventory"]));
      expect(provider.calls.some((purpose) => purpose.startsWith("need_extract"))).toBe(true);
      expect(provider.calls.some((purpose) => purpose.startsWith("inventory"))).toBe(true);
      const rows = await listClaims(f.workspace_id);
      expect(rows).toHaveLength(4);
      await connection.unsafe(`DROP TRIGGER ${triggerName} ON accuracy_claims`);
      const gaps = [0, 1, 2].map((index) => rows.find((row) => row.statement === `Need ${index}`)!);
      await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [gaps[0].id], action: "validate", rationale: "Reviewed evidence", actor });
      await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [gaps[1].id], action: "reject", rationale: "Rejected evidence", actor });
      await updateClaim({ workspace_id: f.workspace_id, claim_id: gaps[2].id,
        patch: { statement: "Human wording", status_override: "addressed" }, rationale: "Human correction", actor });
      provider.calls = [];
      provider.reply = () => { throw new Error("Saved extraction must not call the provider again"); };
      const retried = await extract({ ...f, kinds: ["need", "inventory"], continuation: failed.body.continuation });
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ ok: true, complete: true, continuation: null, gaps_inserted: 0, tactics_inserted: 0 });
      expect(retried.body.runs.map((run: { call_kind: string }) => run.call_kind)).toEqual(["merge_dedupe", "status_derive"]);
      expect(provider.calls).toEqual([]);
      const reloaded = await listClaims(f.workspace_id);
      expect(reloaded.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
      expect(reloaded.find((row) => row.id === gaps[0].id)?.validated).toBe(true);
      expect(reloaded.find((row) => row.id === gaps[1].id)?.status).toBe("rejected");
      const edited = reloaded.find((row) => row.id === gaps[2].id)!;
      expect(edited.statement).toBe("Human wording");
      expect(claimMetadata(edited).status_override?.status).toBe("addressed");
    } finally {
      await connection.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON accuracy_claims`);
      await connection.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await connection.end();
    }
  });

  it("invalidates continuation when blocks are reordered without changing their text", async () => {
    const f = await fixture();
    const first = await extract({ ...f, kinds: ["need"] });
    await accuracyDb().update(accuracyParseBlocks).set({ index: 90 }).where(eq(accuracyParseBlocks.id, f.blocks[0].id));
    const changed = await extract({ ...f, kinds: ["need"], continuation: first.body.continuation });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ restart_required: true, code: "stale_continuation" });
  });

  it("rolls back all claims and the checkpoint if a later claim has an invalid quote", async () => {
    const f = await fixture(2);
    const page = await prepareExtractPage({ ...f, reference_pack_id: null, kinds: ["need"] });
    // Test persistence directly: the extraction judge now filters bad quotes
    // before API results reach this final database guard.
    const valid = {
      claim_type: "gap" as const, statement: "Need evidence", status: "draft", metadata: {},
      provenance: gapReply(f, 0).gaps[0].provenance,
    };
    await expect(saveExtractBatch({ page, kind: "need", run_id: "invalid-later-quote", claims: [valid, {
      ...valid, statement: "Other need",
      provenance: [{ source_file_id: f.source_file_id, block_id: f.blocks[1].id, quote: "Invalid quote" }],
    }] })).rejects.toThrow(/invalid quote/);
    expect(await listClaims(f.workspace_id)).toHaveLength(0);
    expect(await completedExtractKinds(page)).toEqual(new Set());
    expect(await saveExtractBatch({ page, kind: "need", run_id: "valid-retry", claims: [valid] })).toBe(1);
    expect(await listClaims(f.workspace_id)).toHaveLength(1);
    expect(await completedExtractKinds(page)).toEqual(new Set(["need"]));
  });

  it("saves supported API results, filters unsupported quotes and reuses the completed checkpoint", async () => {
    const f = await fixture(2);
    provider.reply = () => ({ gaps: [gapReply(f, 0).gaps[0], {
      ...gapReply(f, 1, "Unsupported need").gaps[0],
      provenance: [{ source_file_id: f.source_file_id, block_id: f.blocks[1].id, quote: "Invented quote" }],
    }] });
    const result = await extract({ ...f, kinds: ["need"] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ complete: true, blocks_processed: 2, gaps_inserted: 1 });
    expect((await listClaims(f.workspace_id)).map((claim) => claim.statement)).toEqual(["Need evidence"]);
    provider.calls = [];
    const retry = await extract({ ...f, kinds: ["need"] });
    expect(retry.body).toMatchObject({ complete: true, gaps_inserted: 0 });
    expect(provider.calls.some((call) => call.startsWith("need_extract"))).toBe(false);
    expect(await listClaims(f.workspace_id)).toHaveLength(1);
  });

  it("does not regenerate saved work or overwrite validated, rejected or edited claims on retry", async () => {
    const f = await fixture(3);
    provider.reply = () => ({ gaps: f.blocks.map((_, index) => gapReply(f, index, `Need ${index}`).gaps[0]) });
    expect((await extract({ ...f, kinds: ["need"] })).status).toBe(200);
    const rows = await listClaims(f.workspace_id);
    await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [rows[0].id], action: "validate", rationale: "Reviewed evidence", actor });
    await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [rows[1].id], action: "reject", rationale: "Rejected evidence", actor });
    await updateClaim({ workspace_id: f.workspace_id, claim_id: rows[2].id, patch: { statement: "Human wording", status_override: "addressed" }, rationale: "Human correction", actor });
    provider.calls = [];
    provider.reply = () => ({ gaps: f.blocks.map((_, index) => gapReply(f, index, `Fresh paraphrase ${index}`).gaps[0]) });
    const retry = await extract({ ...f, kinds: ["need"] });
    expect(retry.body).toMatchObject({ ok: true, gaps_inserted: 0 });
    const reloaded = await listClaims(f.workspace_id);
    expect(reloaded).toHaveLength(3);
    expect(reloaded.find((row) => row.id === rows[0].id)?.validated).toBe(true);
    expect(reloaded.find((row) => row.id === rows[1].id)?.status).toBe("rejected");
    const edited = reloaded.find((row) => row.id === rows[2].id)!;
    expect(edited.statement).toBe("Human wording");
    expect(claimMetadata(edited).status_override?.status).toBe("addressed");
    expect(provider.calls.some((call) => call.startsWith("need_extract"))).toBe(false);
  });

  it("atomically inserts a page once when duplicate requests generate different IDs and wording", async () => {
    const f = await fixture(1);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    provider.reply = async () => {
      const index = ++arrivals;
      if (arrivals === 2) release();
      await barrier;
      return gapReply(f, 0, `Different wording ${index}`);
    };
    const results = await Promise.all([extract({ ...f, kinds: ["need"] }), extract({ ...f, kinds: ["need"] })]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.reduce((sum, result) => sum + result.body.gaps_inserted, 0)).toBe(1);
    expect(await listClaims(f.workspace_id)).toHaveLength(1);
  });

  it.each(["quote", "source", "page"])("rejects invalid %s provenance without saving claims or completing the kind", async (bad) => {
    const f = await fixture();
    const page = await prepareExtractPage({ ...f, reference_pack_id: null, kinds: ["need"] });
    const reply = gapReply(f, bad === "page" ? 80 : 0);
    if (bad === "quote") reply.gaps[0].provenance[0].quote = "Invented quote";
    if (bad === "source") reply.gaps[0].provenance[0].source_file_id = "other-source";
    await expect(saveExtractBatch({ page, kind: "need", run_id: `invalid-${bad}`, claims: [{
      claim_type: "gap", statement: "Unsupported need", status: "draft", metadata: {},
      provenance: reply.gaps[0].provenance,
    }] })).rejects.toThrow(/invalid quote/);
    expect(await listClaims(f.workspace_id)).toHaveLength(0);
    expect(await completedExtractKinds(page)).toEqual(new Set());
    expect(await saveExtractBatch({ page, kind: "need", run_id: "empty-retry", claims: [] })).toBe(0);
    expect(await completedExtractKinds(page)).toEqual(new Set(["need"]));
  });
});
