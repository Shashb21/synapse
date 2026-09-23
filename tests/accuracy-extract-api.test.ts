import { describe, expect, it } from "vitest";
import { POST as extractPost } from "@/app/api/accuracy/extract/route";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { blocksFromParsedDocument, persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
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
    expect(json.runs?.map((r) => r.call_kind).sort()).toEqual([
      "inventory_extract",
      "merge_dedupe",
      "need_extract",
      "status_derive",
    ]);
    expect((json as { statuses_updated?: number }).statuses_updated).toBeDefined();

    const claims = await listClaims(workspace_id);
    expect(claims).toHaveLength(0);
  });

  it("merge_dedupe refuses to re-insert an existing external_id claim", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("extract-dedupe");
    const existing = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need clinical evidence in NSCLC",
      status: "open",
      metadata: { external_id: "NSCLC_CE_04", provenance: [] },
    });

    const merge = await runAccuracyModule<{
      inserted: number;
      merged: number;
      decisions: Array<{ action: string; matched_id: string | null }>;
    }>({
      call_kind: "merge_dedupe",
      input: {
        workspace_id,
        existing: [
          {
            id: existing.id,
            claim_type: "gap",
            statement: existing.statement,
            external_id: "NSCLC_CE_04",
          },
        ],
        incoming: [
          {
            id: "gap_dup",
            claim_type: "gap",
            statement: "Clinical evidence need NSCLC_CE_04",
            external_id: "NSCLC_CE_04",
            provenance: [{ block_id: "B1", quote: "NSCLC_CE_04" }],
          },
        ],
      },
      actor: { name: "test", function: "medical_affairs" },
      org_id,
      workspace_id,
    });

    expect(merge.output.inserted).toBe(0);
    expect(merge.output.merged).toBe(1);
    expect(merge.output.decisions[0]?.matched_id).toBe(existing.id);
  });
});
