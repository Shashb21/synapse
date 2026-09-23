import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as blocksGet } from "@/app/api/accuracy/sources/blocks/route";
import {
  previewQuoteIsValidatable,
  quoteFromPreview,
  toParseBlockPreview,
  toParseBlockPreviews,
} from "@/accuracy/store/parse-preview";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { validateQuoteAgainstBlock } from "@/accuracy/store/quote-validator";

const BGB_PACK = "beone-bgb-58067-prmt5i";
const TISLE_PACK = "beone-tislelizumab-iegp";

const BGB_BLOCK_TEXT =
  "NSCLC_CE_01: Need comparative OS evidence versus pembrolizumab in 1L NSCLC.";
const TISLE_BLOCK_TEXT = "G:1 RWE chart review for ESCC post-hoc survival in EU5.";

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

async function seedSourceWithBlocks(args: {
  label: string;
  filename: string;
  pack: string;
  blocks: Array<{ text: string; kind?: "prose" | "heading"; heading?: string | null }>;
}) {
  const { org_id, workspace_id } = await freshWorkspace(args.label);
  const source = await insertSourceFile({
    workspace_id,
    org_id,
    filename: args.filename,
    mime: "text/plain",
    checksum: `sum-${args.label}-${Date.now()}`,
    doc_role: "medical",
    reference_pack_id: args.pack,
  });
  const stored = args.blocks.map((block, index) => ({
    id: `${source.id}-B${String(index + 1).padStart(3, "0")}`,
    source_file_id: source.id,
    index,
    kind: block.kind ?? "prose",
    heading: block.heading ?? null,
    text: block.text,
  }));
  await persistParseBlocks({
    workspace_id,
    source_file_id: source.id,
    parser: "local_structured",
    blocks: stored,
  });
  return { org_id, workspace_id, source, stored };
}

describe("parse-block preview mapper", () => {
  it("keeps stored text byte-identical (no rewrite or ellipsis)", () => {
    const text = "  Need OS   evidence\nfor EGFR NSCLC  ";
    const preview = toParseBlockPreview({
      id: "blk-1",
      source_file_id: "src-1",
      index: 2,
      kind: "prose",
      heading: "Evidence needs",
      text,
    });
    expect(preview.text).toBe(text);
    expect(preview.text).not.toContain("…");
    expect(quoteFromPreview(preview)).toBe(text);
  });

  it("orders previews by block index", () => {
    const previews = toParseBlockPreviews([
      {
        id: "b-late",
        source_file_id: "src-1",
        index: 2,
        kind: "prose",
        heading: null,
        text: "second",
      },
      {
        id: "b-early",
        source_file_id: "src-1",
        index: 0,
        kind: "heading",
        heading: "Intro",
        text: "first",
      },
    ]);
    expect(previews.map((p) => p.id)).toEqual(["b-early", "b-late"]);
  });

  it("accepts the full preview text and a substring quote against the stored block", () => {
    const stored = { text: BGB_BLOCK_TEXT };
    const preview = toParseBlockPreview({
      id: "blk-bgb",
      source_file_id: "src-bgb",
      index: 0,
      kind: "prose",
      heading: null,
      text: BGB_BLOCK_TEXT,
    });
    expect(previewQuoteIsValidatable({ stored, preview }).ok).toBe(true);
    expect(
      previewQuoteIsValidatable({ stored, preview, quote: "NSCLC_CE_01" }).ok,
    ).toBe(true);
    expect(validateQuoteAgainstBlock({ block: stored, quote: quoteFromPreview(preview) }).ok).toBe(
      true,
    );
  });

  it("rejects paraphrased quotes that are not substrings", () => {
    const stored = { text: BGB_BLOCK_TEXT };
    const preview = toParseBlockPreview({
      id: "blk-bgb",
      source_file_id: "src-bgb",
      index: 0,
      kind: "prose",
      heading: null,
      text: BGB_BLOCK_TEXT,
    });
    const result = previewQuoteIsValidatable({
      stored,
      preview,
      quote: "Need overall survival vs Keytruda in first-line lung cancer",
    });
    expect(result.ok).toBe(false);
  });
});

describe("parse-block preview API", () => {
  it("requires workspace_id and source_file_id", async () => {
    const missingWs = await blocksGet(
      new Request("http://localhost/api/accuracy/sources/blocks"),
    );
    expect(missingWs.status).toBe(400);

    const missingSrc = await blocksGet(
      new Request("http://localhost/api/accuracy/sources/blocks?workspace_id=ws-x"),
    );
    expect(missingSrc.status).toBe(400);
  });

  it("returns verbatim blocks for one source; quotes stay substring-validatable", async () => {
    const fixture = await seedSourceWithBlocks({
      label: "preview-bgb",
      filename: "bgb-plan.txt",
      pack: BGB_PACK,
      blocks: [
        { text: "Heading BGB", kind: "heading", heading: "Slide 1" },
        { text: BGB_BLOCK_TEXT },
      ],
    });

    const res = await blocksGet(
      new Request(
        `http://localhost/api/accuracy/sources/blocks?workspace_id=${fixture.workspace_id}&source_file_id=${fixture.source.id}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reference_pack_id: string | null;
      block_count: number;
      blocks: Array<{ id: string; text: string; source_file_id: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.reference_pack_id).toBe(BGB_PACK);
    expect(body.block_count).toBe(2);
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[1]?.text).toBe(BGB_BLOCK_TEXT);
    expect(body.blocks.every((b) => b.source_file_id === fixture.source.id)).toBe(true);

    const stored = fixture.stored[1]!;
    const preview = body.blocks[1]!;
    expect(
      validateQuoteAgainstBlock({ block: stored, quote: preview.text }).ok,
    ).toBe(true);
    expect(
      validateQuoteAgainstBlock({ block: stored, quote: "comparative OS evidence" }).ok,
    ).toBe(true);
  });

  it("does not mix BeOne gold parse blocks across packs", async () => {
    const bgb = await seedSourceWithBlocks({
      label: "pack-bgb",
      filename: "bgb.txt",
      pack: BGB_PACK,
      blocks: [{ text: BGB_BLOCK_TEXT }],
    });
    const tisle = await seedSourceWithBlocks({
      label: "pack-tisle",
      filename: "tisle.txt",
      pack: TISLE_PACK,
      blocks: [{ text: TISLE_BLOCK_TEXT }],
    });

    const bgbRes = await blocksGet(
      new Request(
        `http://localhost/api/accuracy/sources/blocks?workspace_id=${bgb.workspace_id}&source_file_id=${bgb.source.id}`,
      ),
    );
    const tisleRes = await blocksGet(
      new Request(
        `http://localhost/api/accuracy/sources/blocks?workspace_id=${tisle.workspace_id}&source_file_id=${tisle.source.id}`,
      ),
    );
    const bgbBody = (await bgbRes.json()) as {
      reference_pack_id: string | null;
      blocks: Array<{ text: string }>;
    };
    const tisleBody = (await tisleRes.json()) as {
      reference_pack_id: string | null;
      blocks: Array<{ text: string }>;
    };

    expect(bgbBody.reference_pack_id).toBe(BGB_PACK);
    expect(tisleBody.reference_pack_id).toBe(TISLE_PACK);
    expect(bgbBody.blocks.map((b) => b.text)).toEqual([BGB_BLOCK_TEXT]);
    expect(tisleBody.blocks.map((b) => b.text)).toEqual([TISLE_BLOCK_TEXT]);
    expect(bgbBody.blocks.some((b) => b.text.includes("G:1"))).toBe(false);
    expect(tisleBody.blocks.some((b) => b.text.includes("NSCLC_CE_01"))).toBe(false);

    const cross = await blocksGet(
      new Request(
        `http://localhost/api/accuracy/sources/blocks?workspace_id=${bgb.workspace_id}&source_file_id=${tisle.source.id}`,
      ),
    );
    expect(cross.status).toBe(404);
  });
});

describe("Sources UI preview wiring", () => {
  it("renders ParseBlockPreview with verbatim block text (no excerpt ellipsis)", () => {
    const page = readFileSync(
      path.join(process.cwd(), "src/app/accuracy/sources/page.tsx"),
      "utf8",
    );
    expect(page).toContain("ParseBlockPreview");
    expect(page).toContain("toParseBlockPreviews");
    expect(page).toContain("parse_blocks");
    expect(page).toContain("verbatim parse blocks");

    const ui = readFileSync(
      path.join(process.cwd(), "src/components/accuracy/parse-block-preview.tsx"),
      "utf8",
    );
    expect(ui).toContain("data-testid=\"parse-block-preview\"");
    expect(ui).toContain("data-testid=\"parse-block-text\"");
    expect(ui).toContain("{block.text}");
    expect(ui).toContain("whitespace-pre-wrap");
    expect(ui).not.toContain("excerptFromBlock");
    expect(ui).not.toContain("…");

    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/accuracy/sources/blocks/route.ts"),
      "utf8",
    );
    expect(route).toContain("toParseBlockPreviews");
    expect(route).toContain("source_file_id required");
  });
});
