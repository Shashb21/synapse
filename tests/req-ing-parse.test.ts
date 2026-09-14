import { describe, expect, it } from "vitest";
import { parseLocalDocument } from "@/lib/ingest/local-parse";
import { buildAllFixtures } from "@/lib/seed/build-files";

describe("REQ-ING document ingest", () => {
  it("REQ-ING-001/002/003 parses PPTX, DOCX, and XLSX into source blocks", async () => {
    const files = await buildAllFixtures();
    const pptx = files.find((f) => f.filename.endsWith(".pptx"));
    const docx = files.find((f) => f.filename.endsWith(".docx"));
    const xlsx = files.find((f) => f.filename.endsWith(".xlsx"));
    expect(pptx && docx && xlsx).toBeTruthy();
    const parsedPptx = await parseLocalDocument(pptx!);
    const parsedDocx = await parseLocalDocument(docx!);
    const parsedXlsx = await parseLocalDocument(xlsx!);
    expect(parsedPptx.blocks.length).toBeGreaterThan(3);
    expect(parsedDocx.blocks.length).toBeGreaterThan(3);
    expect(parsedXlsx.blocks.length).toBeGreaterThan(3);
    expect(parsedPptx.fullText.toLowerCase()).toMatch(/velmara|payer|unbranded/);
    expect(parsedDocx.fullText).toMatch(/KOL|intracranial|resistance/i);
    expect(parsedXlsx.fullText).toMatch(/VEL-203|washout/i);
  }, 30_000);
});
