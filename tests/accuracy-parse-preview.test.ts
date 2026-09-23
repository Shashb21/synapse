import { describe, expect, it } from "vitest";
import { GET as blocksGet } from "@/app/api/accuracy/sources/blocks/route";
import { registerAccuracyStack } from "@/accuracy";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-parse-preview-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS parse preview ${label}`,
    slug: `parse-preview-${label}-${Date.now()}`,
  });
  return { org_id, workspace_id };
}

function getBlocks(workspace_id: string, source_file_id?: string) {
  const url = new URL("http://localhost/api/accuracy/sources/blocks");
  url.searchParams.set("workspace_id", workspace_id);
  if (source_file_id) url.searchParams.set("source_file_id", source_file_id);
  return blocksGet(new Request(url.toString()));
}

describe("accuracy Sources parse-block preview API", () => {
  it("requires workspace_id and source_file_id", async () => {
    registerAccuracyStack();
    const missingWs = await blocksGet(
      new Request("http://localhost/api/accuracy/sources/blocks"),
    );
    expect(missingWs.status).toBe(400);
    const missingSource = await getBlocks("ws-any");
    expect(missingSource.status).toBe(400);
    const body = (await missingSource.json()) as { error?: string };
    expect(body.error).toMatch(/source_file_id/i);
  });

  it("returns 404 for unknown workspace or source", async () => {
    registerAccuracyStack();
    const unknownWs = await getBlocks("ws-missing-preview", "src-1");
    expect(unknownWs.status).toBe(404);

    const { org_id, workspace_id } = await freshWorkspace("404");
    const unknownSrc = await getBlocks(workspace_id, "src-missing");
    expect(unknownSrc.status).toBe(404);
    void org_id;
  });

  it("returns verbatim blocks ordered by index with parser badge field", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("order");
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "iep-preview.txt",
      mime: "text/plain",
      checksum: `sum-preview-${Date.now()}`,
      doc_role: "medical",
    });

    await persistParseBlocks({
      workspace_id,
      source_file_id: source.id,
      parser: "local_structured",
      blocks: [
        {
          id: `${source.id}-B002`,
          source_file_id: source.id,
          index: 2,
          kind: "list_item",
          heading: "Tactics",
          text: "Chart review in EU5 centres for pneumonitis signals.",
        },
        {
          id: `${source.id}-B000`,
          source_file_id: source.id,
          index: 0,
          kind: "heading",
          heading: null,
          text: "Evidence gaps",
        },
        {
          id: `${source.id}-B001`,
          source_file_id: source.id,
          index: 1,
          kind: "prose",
          heading: "Needs",
          text: "Need OS evidence in EGFR NSCLC after second-line failure.",
        },
      ],
    });

    const res = await getBlocks(workspace_id, source.id);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok?: boolean;
      filename?: string;
      block_count?: number;
      parser?: string | null;
      blocks?: Array<{ id: string; index: number; kind: string; text: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.filename).toBe("iep-preview.txt");
    expect(json.block_count).toBe(3);
    expect(json.parser).toBe("local_structured");
    expect(json.blocks?.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(json.blocks?.[1]?.text).toContain("Need OS evidence");
    expect(json.blocks?.[2]?.kind).toBe("list_item");
  });
});
