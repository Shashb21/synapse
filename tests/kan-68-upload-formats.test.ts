import { describe, expect, it, vi } from "vitest";
import { Document, Packer, Paragraph } from "docx";
import * as XLSX from "xlsx";

// The route reads the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { loadState, resetDemoSetup } from "@/lib/iegp/store";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import { MAX_UPLOAD_BYTES, uploadKindOf } from "@/lib/ingest/upload-formats";

/**
 * KAN-68: Add a source takes PDF, DOCX, PPTX and XLSX as well as text. A binary file is
 * posted as base64 with its filename, stored by S0 and parsed into blocks by S1.
 */

const ACTOR = { actor_name: "Upload Tester", actor_function: "medical_affairs" };

async function ingest(body: Record<string, string>) {
  const res = await iegpPost(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ACTOR,
        action: "ingest",
        source_type: "advisory_board",
        stakeholder_function: "market_access",
        ...body,
      }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok?: boolean; error?: string } };
}

async function docxBase64(lines: string[]): Promise<string> {
  const doc = new Document({ sections: [{ children: lines.map((line) => new Paragraph(line)) }] });
  return (await Packer.toBuffer(doc)).toString("base64");
}

function xlsxBase64(rows: string[][]): string {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Evidence");
  return (XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}

async function blocksOf(title: string) {
  const state = await loadState();
  const source = state.sources.find((row) => row.title === title);
  expect(source).toBeTruthy();
  return state.blocks.filter((block) => block.source_id === source!.id);
}

describe("ingest of PDF and Office files (KAN-68)", () => {
  it("reads a DOCX through S0 and S1 into blocks", async () => {
    await resetDemoSetup();
    await resetWorkspaceModules();
    const content_base64 = await docxBase64([
      "Payer advisory board, March.",
      "Payers need real-world persistence data beyond month six in community oncology.",
    ]);
    const res = await ingest({ title: "Payer board docx", filename: "payer-board.docx", content_base64 });
    expect(res.json.error).toBeUndefined();
    expect(res.status).toBe(200);
    const file = (await listSourceFiles()).find((row) => row.filename === "payer-board.docx");
    expect(file?.mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(file?.status).toBe("parsed");
    const blocks = await blocksOf("Payer board docx");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((block) => block.text).join(" ")).toMatch(/persistence data beyond month six/);
  });

  it("reads an XLSX through S0 and S1 into blocks", async () => {
    const content_base64 = xlsxBase64([
      ["Topic", "Need"],
      ["HEOR", "No cost-effectiveness model versus standard of care in second line."],
    ]);
    const res = await ingest({
      title: "Evidence tracker xlsx",
      filename: "tracker.xlsx",
      content_base64,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(res.json.error).toBeUndefined();
    expect(res.status).toBe(200);
    const blocks = await blocksOf("Evidence tracker xlsx");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((block) => block.text).join(" ")).toMatch(/cost-effectiveness model/);
  });

  it("still reads pasted text", async () => {
    const res = await ingest({ title: "Pasted notes", text: "Payers want comparative evidence versus nivolumab." });
    expect(res.status).toBe(200);
    expect((await blocksOf("Pasted notes")).length).toBeGreaterThan(0);
  });

  it("refuses unsupported and old Office types", async () => {
    const content_base64 = Buffer.from("not a deck").toString("base64");
    const key = await ingest({ title: "Keynote", filename: "deck.key", content_base64 });
    expect(key.status).toBe(400);
    expect(key.json.error).toMatch(/Choose a PDF, Word \(\.docx\)/);
    const doc = await ingest({ title: "Old doc", filename: "notes.doc", content_base64 });
    expect(doc.status).toBe(400);
    expect(doc.json.error).toBe(".doc is an old Office format. Save it as .docx and choose it again.");
    const mismatch = await ingest({ title: "Mismatch", filename: "a.docx", content_base64, mime: "application/pdf" });
    expect(mismatch.status).toBe(400);
    const textAsFile = await ingest({ title: "Text as file", filename: "a.txt", content_base64 });
    expect(textAsFile.status).toBe(400);
    const noName = await ingest({ title: "No name", content_base64 });
    expect(noName.status).toBe(400);
    expect(uploadKindOf("Deck.PPTX")).toEqual({
      kind: "binary",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(uploadKindOf("notes.markdown")).toEqual({ kind: "text" });
  });

  it("refuses a file over the size limit", async () => {
    const content_base64 = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1).toString("base64");
    const res = await ingest({ title: "Too big", filename: "big.pdf", content_base64 });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/over 3 MB/);
  });

  it("refuses text and a file sent together", async () => {
    const content_base64 = await docxBase64(["Both at once."]);
    const res = await ingest({ title: "Both", filename: "both.docx", content_base64, text: "Both at once." });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Send the source as text or as a file, not both.");
    expect((await listSourceFiles()).some((row) => row.filename === "both.docx")).toBe(false);
  });
});
