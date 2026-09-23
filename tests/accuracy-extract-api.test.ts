import { describe, expect, it } from "vitest";
import { POST as extractPost } from "@/app/api/accuracy/extract/route";
import { registerAccuracyStack } from "@/accuracy";
import { listClaims } from "@/accuracy/store/claim-store";
import { blocksFromParsedDocument, persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";

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

    const claims = await listClaims(workspace_id);
    expect(claims).toHaveLength(0);
    expect(json.provider_id).toBeNull();
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
});
