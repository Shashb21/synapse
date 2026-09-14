import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import PptxGenJS from "pptxgenjs";
import * as XLSX from "xlsx";
import { SEED_DOCUMENTS } from "@/lib/seed/corpus";

export type FixtureFile = {
  filename: string;
  mime: string;
  buffer: Buffer;
};

async function pptxFromDoc(docId: string): Promise<Buffer> {
  const doc = SEED_DOCUMENTS.find((d) => d.id === docId)!;
  const pptx = new PptxGenJS();
  pptx.author = "Velmara Insights Engine";
  pptx.title = doc.title;
  const bySlide = new Map<string, typeof doc.blocks>();
  for (const block of doc.blocks) {
    const key = block.location.ref;
    const list = bySlide.get(key) ?? [];
    list.push(block);
    bySlide.set(key, list);
  }
  for (const [, blocks] of bySlide) {
    const slide = pptx.addSlide();
    const title = blocks.find((b) => b.kind === "title")?.text ?? blocks[0]?.heading ?? doc.title;
    slide.addText(title, {
      x: 0.5,
      y: 0.3,
      w: 9,
      h: 0.6,
      fontSize: 20,
      bold: true,
      color: "1A2332",
      fontFace: "Calibri",
    });
    const body = blocks.filter((b) => b.kind !== "title");
    slide.addText(
      body.map((b) => ({
        text: b.text,
        options: { bullet: b.kind === "bullet", breakLine: true, fontSize: 14 },
      })),
      { x: 0.5, y: 1.1, w: 9, h: 5.2, color: "1A2332", fontFace: "Calibri" },
    );
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(out as ArrayBuffer);
}

async function docxFromMed(): Promise<Buffer> {
  const doc = SEED_DOCUMENTS.find((d) => d.id === "DOC-MED-001")!;
  const children = [
    new Paragraph({
      text: doc.title,
      heading: HeadingLevel.HEADING_1,
    }),
    ...doc.blocks.map(
      (b) =>
        new Paragraph({
          spacing: { after: 240 },
          children: [
            new TextRun({ text: b.heading ? `${b.heading}. ` : "", bold: true }),
            new TextRun(b.text),
          ],
        }),
    ),
  ];
  const file = new Document({
    sections: [{ children }],
  });
  const buf = await Packer.toBuffer(file);
  return Buffer.from(buf);
}

function xlsxFromClinops(): Buffer {
  const wb = XLSX.utils.book_new();
  const rows = [
    ["Metric", "Value", "Note"],
    ["Target enrollment", 420, "Protocol VEL-203 target 420, enrolled 281 (67%) at month 14."],
    ["Enrolled", 281, "67% of target at month 14"],
    ["Screen fail rate", "41%", "Primary reason prior TKI washout window."],
    ["Southern EU activation (months)", 4.2, "Southern EU site activation is 4.2 months versus 2.1 months in the US."],
    ["US activation (months)", 2.1, "US comparator"],
    [
      "Protocol opportunity",
      "Amendment",
      "Opportunity: protocol amendment to allow concurrent biopsy during washout.",
    ],
    [
      "Competitive risk",
      "Unknown",
      "Unknown: impact of competing NX-441 phase 3 on remaining US sites.",
    ],
    ["Japan FPI", "Sep 2026", "Japan first-patient-in slipped from May to September 2026."],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, sheet, "Enrollment");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

export async function buildAllFixtures(): Promise<FixtureFile[]> {
  const commercial = await pptxFromDoc("DOC-COM-001");
  const access = await pptxFromDoc("DOC-MA-001");
  const marketing = await pptxFromDoc("DOC-MKT-001");
  const med = await docxFromMed();
  const xlsx = xlsxFromClinops();
  return [
    {
      filename: "Velmara_US_Brand_Plan_Q3_2026.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: commercial,
    },
    {
      filename: "Velmara_Payer_AdBoard_Sep2026.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: access,
    },
    {
      filename: "Velmara_KOL_Insights_Q3_2026.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: med,
    },
    {
      filename: "VEL-203_Enrollment_Dashboard_Sep2026.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: xlsx,
    },
    {
      filename: "Velmara_Unbranded_Campaign_Readout_Q3.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: marketing,
    },
  ];
}
