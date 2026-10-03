import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { POST as extractPost } from "@/app/api/accuracy/extract/route";
import { registerAccuracyStack } from "@/accuracy";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { listClaims } from "@/accuracy/store/claim-store";
import { listAssemblies } from "@/accuracy/store/assembly-store";
import { blocksFromParsedDocument, persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import * as accuracyTables from "@/accuracy/store/schema";
import { newId } from "@/modules/kernel/ids";

const identity = vi.hoisted(() => ({
  actor: { name: "Session Extractor", function: "medical_affairs" as const },
  role: "medical_affairs" as const,
  signed_in: true,
  demo: false,
  subject: "extract-subject" as string | null,
}));
vi.mock("@/modules/auth/request", () => ({ requestIdentity: async () => identity }));

const originals = new Map<string, string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind: call_kind as never, module_id, activated_by: "extract test restore" });
  originals.clear();
  Object.assign(identity, {
    actor: { name: "Session Extractor", function: "medical_affairs" as const },
    role: "medical_affairs" as const,
    signed_in: true,
    demo: false,
    subject: "extract-subject",
  });
});

async function freshWorkspace(label: string, grant = true) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
  if (grant) await grantOrganizationAccess({ subject: identity.subject!, org_id });
  return { org_id, workspace_id };
}

async function postExtract(body: Record<string, unknown>) {
  return extractPost(
    new Request("http://localhost/api/accuracy/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function installModule(call_kind: "need_extract" | "inventory_extract" | "coverage_decide", run: (input: Record<string, unknown>) => Promise<unknown>) {
  const original = activeAccuracyModuleId(call_kind);
  if (original) originals.set(call_kind, original);
  const schemas = {
    need_extract: {
      input: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()) }),
      output: z.object({ workspace_id: z.string(), source_file_id: z.string(), gaps: z.array(z.object({ id: z.string(), statement: z.string(), external_id: z.string().nullable(), provenance: z.array(z.object({ source_file_id: z.string(), block_id: z.string(), quote: z.string() })) })) }),
    },
    inventory_extract: {
      input: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()) }),
      output: z.object({ workspace_id: z.string(), source_file_id: z.string(), tactics: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), status: z.enum(["completed", "ongoing", "planned", "proposed", "cancelled"]), evidence_question: z.string(), origin: z.literal("inventory"), provenance: z.array(z.object({ source_file_id: z.string(), block_id: z.string(), quote: z.string() })) })) }),
    },
    coverage_decide: {
      input: z.object({ workspace_id: z.string(), gap_id: z.string(), tactic_id: z.string(), block_bundle_ids: z.array(z.string()), selected_versions: z.unknown().optional(), generation_context: z.unknown().optional() }),
      output: z.object({ gap_id: z.string(), tactic_id: z.string(), overall: z.enum(["full", "partial", "limited", "not_relevant"]), quote_block_ids: z.array(z.string()), confidence: z.number(), rationale: z.string() }),
    },
  }[call_kind];
  const id = `${call_kind}-extract-api-test`;
  registerAccuracyModule(mechanicalModule({ id, call_kind, title: "Extract API controlled", summary: "Extract API controlled",
    inputSchema: schemas.input as never, outputSchema: schemas.output as never, run: async input => ({ output: await run(input as Record<string, unknown>), summary: call_kind }) }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "extract api test" });
}

describe("accuracy extract API", () => {
  it("rejects unknown workspace and source without blocks", async () => {
    registerAccuracyStack();
    const missingWs = await postExtract({
      workspace_id: "ws-missing",
      source_file_id: "src-1",
      kinds: ["need"],
    });
    expect(missingWs.status).toBe(404);

    const { org_id, workspace_id } = await freshWorkspace("extract-empty");
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "empty.txt",
      mime: "text/plain",
      checksum: "abc",
      doc_role: "medical",
    });
    const noBlocks = await postExtract({
      workspace_id,
      source_file_id: source.id,
      kinds: ["need", "inventory"],
    });
    expect(noBlocks.status).toBe(400);
    const body = (await noBlocks.json()) as { error?: string };
    expect(body.error).toMatch(/parse blocks/i);
  });

  it("runs stub extract and reports zero inserts under SYNAPSE_TEST_STUB_LLM", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("extract-stub");
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "notes.txt",
      mime: "text/plain",
      checksum: `sum-${Date.now()}`,
      doc_role: "medical",
    });
    const blocks = blocksFromParsedDocument({
      workspace_id,
      source_file_id: source.id,
      blocks: [
        {
          id: `${source.id}-B001`,
          text: "Need OS evidence in EGFR NSCLC",
          kind: "paragraph",
          heading: "Evidence needs",
        },
      ],
    });
    await persistParseBlocks({
      workspace_id,
      source_file_id: source.id,
      parser: "local",
      blocks,
    });

    const res = await postExtract({
      workspace_id,
      source_file_id: source.id,
      kinds: ["need", "inventory"],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok?: boolean;
      gaps_inserted?: number;
      tactics_inserted?: number;
      stub?: boolean;
      provider_id?: string | null;
      block_count?: number;
      blocks_used?: number;
      runs?: Array<{ call_kind: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.stub).toBe(true);
    expect(json.block_count).toBe(1);
    expect(json.blocks_used).toBe(1);
    expect(json.gaps_inserted).toBe(0);
    expect(json.tactics_inserted).toBe(0);
    expect(json.runs?.map((r) => r.call_kind)).toEqual([
      "need_extract",
      "inventory_extract",
      "merge_dedupe",
      "status_derive",
    ]);
    expect(json).toMatchObject({ assembly_id: expect.any(String), assembly_checks: expect.objectContaining({ status: "passed" }) });

    const claims = await listClaims(workspace_id);
    expect(claims).toHaveLength(0);
    expect(json.provider_id).toBeNull();
    const [assembly] = await listAssemblies(workspace_id);
    expect(assembly?.actor).toEqual(identity.actor);
  });

  it("uses the signed-in actor for generation and enforces workspace grants, including demo sessions", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("extract-auth");
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "notes.txt",
      mime: "text/plain",
      checksum: `sum-auth-${Date.now()}`,
      doc_role: "medical",
    });
    await persistParseBlocks({
      workspace_id,
      source_file_id: source.id,
      parser: "local",
      blocks: blocksFromParsedDocument({ workspace_id, source_file_id: source.id, blocks: [
        { id: `${source.id}-B001`, text: "Need OS evidence in EGFR NSCLC", kind: "paragraph", heading: "Evidence needs" },
      ] }),
    });

    const forged = await postExtract({
      workspace_id,
      source_file_id: source.id,
      kinds: ["need"],
      actor_name: "Forged Client",
      actor_function: "system",
    });
    expect(forged.status).toBe(200);
    const body = await forged.json() as { assembly_id: string };
    const [assembly] = await listAssemblies(workspace_id);
    expect(assembly?.id).toBe(body.assembly_id);
    expect(assembly?.actor).toEqual(identity.actor);

    const foreign = await freshWorkspace("extract-foreign", false);
    const foreignSource = await insertSourceFile({
      workspace_id: foreign.workspace_id,
      org_id: foreign.org_id,
      filename: "foreign.txt",
      mime: "text/plain",
      checksum: `sum-foreign-${Date.now()}`,
      doc_role: "medical",
    });
    expect((await postExtract({ workspace_id: foreign.workspace_id, source_file_id: foreignSource.id, kinds: ["need"] })).status).toBe(404);

    Object.assign(identity, { demo: true });
    expect((await postExtract({ workspace_id: foreign.workspace_id, source_file_id: foreignSource.id, kinds: ["need"] })).status).toBe(404);

    Object.assign(identity, { signed_in: true, demo: false, subject: null });
    expect((await postExtract({ workspace_id, source_file_id: source.id, kinds: ["need"] })).status).toBe(400);
  });

  it("returns oauth gate with /control when live extract has no connected provider", async () => {
    const prevStub = process.env.SYNAPSE_TEST_STUB_LLM;
    const prevKeys = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_WORKSPACE_ID: process.env.ANTHROPIC_WORKSPACE_ID,
      XAI_API_KEY: process.env.XAI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await ensurePlatformSchema();
    await db().delete(t.oauthConnections);
    try {
      registerAccuracyStack();
      const { org_id, workspace_id } = await freshWorkspace("extract-gate");
      const source = await insertSourceFile({
        workspace_id,
        org_id,
        filename: "notes.txt",
        mime: "text/plain",
        checksum: `sum-gate-${Date.now()}`,
        doc_role: "medical",
      });
      const blocks = blocksFromParsedDocument({
        workspace_id,
        source_file_id: source.id,
        blocks: [
          {
            id: `${source.id}-B001`,
            text: "Need OS evidence in EGFR NSCLC",
            kind: "paragraph",
            heading: "Evidence needs",
          },
        ],
      });
      await persistParseBlocks({
        workspace_id,
        source_file_id: source.id,
        parser: "local",
        blocks,
      });

      const res = await postExtract({
        workspace_id,
        source_file_id: source.id,
        kinds: ["need", "inventory"],
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        gate?: string;
        connect_path?: string;
      };
      expect(json.ok).toBe(false);
      expect(json.gate).toBe("oauth_required");
      expect(json.connect_path).toBe("/control");
      expect(json.error).toMatch(/\/control/i);
    } finally {
      process.env.SYNAPSE_TEST_STUB_LLM = prevStub;
      for (const [name, value] of Object.entries(prevKeys)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects unknown fresh and resume fields while retaining legacy actor fields", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("extract-strict");
    const source = await insertSourceFile({ workspace_id, org_id, filename: "notes.txt", mime: "text/plain", checksum: "strict", doc_role: "medical" });

    expect((await postExtract({ workspace_id, source_file_id: source.id, kinds: ["need"], selected_versions: [] })).status).toBe(400);
    expect((await postExtract({ action: "resume", workspace_id, source_file_id: source.id, extraction_batch_id: "batch", idempotency_key: "k", linking_complete: true })).status).toBe(400);
    expect((await postExtract({ action: "resume", workspace_id, source_file_id: source.id, extraction_batch_id: "batch", idempotency_key: "k",
      actor_name: "Legacy", actor_function: "system" })).status).toBe(409);
  });

  it("returns a generic logged 500 with resumable batch identity when assembly linking fails, then resumes without re-extraction", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("extract-link-fail");
    const source = await insertSourceFile({ workspace_id, org_id, filename: "notes.txt", mime: "text/plain", checksum: `sum-link-${Date.now()}`, doc_role: "medical" });
    await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local",
      blocks: blocksFromParsedDocument({ workspace_id, source_file_id: source.id, blocks: [
        { id: `${source.id}-B001`, text: "Need OS evidence and registry follow up.", kind: "paragraph", heading: "Evidence needs" },
      ] }) });
    let needCalls = 0;
    let inventoryCalls = 0;
    let coverageCalls = 0;
    const gapId = newId("gap-route");
    const tacticId = newId("tactic-route");
    installModule("need_extract", async input => {
      needCalls += 1;
      return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [{ id: gapId, statement: "Need OS evidence", external_id: null,
        provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "Need OS evidence" }] }] };
    });
    installModule("inventory_extract", async input => {
      inventoryCalls += 1;
      return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [{ id: tacticId, name: "Registry follow up", type: "rwe_study", status: "planned",
        evidence_question: "Does registry follow up close the gap?", origin: "inventory",
        provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "registry follow up" }] }] };
    });
    installModule("coverage_decide", async input => {
      coverageCalls += 1;
      if (coverageCalls === 1) throw new Error("private provider trace");
      return { gap_id: input.gap_id, tactic_id: input.tactic_id, overall: "partial", quote_block_ids: input.block_bundle_ids, confidence: 0.8, rationale: "Partial." };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await postExtract({ workspace_id, source_file_id: source.id, kinds: ["need", "inventory"] });
    expect(failed.status).toBe(500);
    const failedBody = await failed.json() as { error: string; assembly_incomplete: boolean; extraction_batch_id: string };
    expect(failedBody).toMatchObject({ assembly_incomplete: true, extraction_batch_id: expect.any(String) });
    expect(JSON.stringify(failedBody)).not.toContain("private provider trace");
    expect(log).toHaveBeenCalledOnce();
    expect(await listAssemblies(workspace_id)).toEqual([]);
    expect(needCalls).toBe(1);
    expect(inventoryCalls).toBe(1);

    const resumed = await postExtract({ action: "resume", workspace_id, source_file_id: source.id,
      extraction_batch_id: failedBody.extraction_batch_id, idempotency_key: "resume-link" });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ ok: true, assembly_id: expect.any(String), assembly_checks: expect.objectContaining({ status: "passed" }) });
    expect(needCalls).toBe(1);
    expect(inventoryCalls).toBe(1);
    expect(coverageCalls).toBe(2);
    expect(await listAssemblies(workspace_id)).toHaveLength(1);
    const runs = await accuracyDb().select().from(accuracyTables.accuracyModuleRuns).where(eq(accuracyTables.accuracyModuleRuns.workspace_id, workspace_id));
    expect(runs.filter(run => run.call_kind === "coverage_decide").map(run => run.status).sort()).toEqual(["error", "ok"]);
  });

  it("maps private fresh and resume assembly runtime failures to one generic 500 log", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("extract-private");
    const source = await insertSourceFile({ workspace_id, org_id, filename: "notes.txt", mime: "text/plain", checksum: `sum-private-${Date.now()}`, doc_role: "medical" });
    await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local",
      blocks: blocksFromParsedDocument({ workspace_id, source_file_id: source.id, blocks: [
        { id: `${source.id}-B001`, text: "Need OS evidence in EGFR NSCLC and registry follow up.", kind: "paragraph", heading: "Evidence needs" },
      ] }) });
    const gapId = newId("gap-private");
    const tacticId = newId("tactic-private");
    installModule("need_extract", async input => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [{ id: gapId, statement: "Need OS evidence", external_id: null,
      provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "Need OS evidence" }] }] }));
    installModule("inventory_extract", async input => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [{ id: tacticId, name: "Registry follow up", type: "rwe_study", status: "planned",
      evidence_question: "Does registry follow up close the gap?", origin: "inventory",
      provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "registry follow up" }] }] }));
    installModule("coverage_decide", async () => { throw new Error("private database detail"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const fresh = await postExtract({ workspace_id, source_file_id: source.id, kinds: ["need", "inventory"] });
    expect(fresh.status).toBe(500);
    const freshBody = await fresh.json() as { error: string; extraction_batch_id: string };
    expect(JSON.stringify(freshBody)).not.toContain("private database detail");
    expect(log).toHaveBeenCalledOnce();

    log.mockClear();
    const resumed = await postExtract({ action: "resume", workspace_id, source_file_id: source.id,
      extraction_batch_id: freshBody.extraction_batch_id, idempotency_key: "resume-private" });
    expect(resumed.status).toBe(500);
    expect(JSON.stringify(await resumed.json())).not.toContain("private database detail");
    expect(log).toHaveBeenCalledOnce();
  });
});
