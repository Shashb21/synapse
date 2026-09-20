import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { splitSourceIntoBlocks } from "./engine";
import { DEMO_JSON_PACK, DEMO_PACK, type DemoSourceFile } from "./demo-pack";

export const DEMO_JSON_INGESTED_AT = "2026-09-20T00:00:00.000Z";

export type ExtractTestDocument = {
  id: string;
  source_key: string;
  filename: string;
  title: string;
  source_type: string;
  stakeholder_function: string;
  mime: string;
  parser: "local" | "llamaparse";
  ingested_at: string;
  blocks?: Array<{
    id: string;
    location: { kind: "section" | "slide" | "page"; ref: string };
    heading: string;
    text: string;
    kind: string;
  }>;
  fullText?: string;
  markdown_full?: string;
  items?: unknown;
};

export function demoFileToParsedJson(file: DemoSourceFile): ExtractTestDocument {
  const sections = splitSourceIntoBlocks(file.text, file.title);
  const blocks = sections.map((section, i) => ({
    id: `B${String(i + 1).padStart(2, "0")}`,
    location: {
      kind: "section" as const,
      ref: section.heading === "Note" ? file.title : section.heading,
    },
    heading: section.heading,
    text: section.text,
    kind: i === 0 && section.heading === "Note" ? "title" : "paragraph",
  }));
  return {
    id: file.id,
    source_key: file.id,
    filename: `${file.id}.json`,
    title: file.title,
    source_type: file.source_type,
    stakeholder_function: file.stakeholder_function,
    mime: "application/json",
    parser: "local",
    ingested_at: DEMO_JSON_INGESTED_AT,
    blocks,
    fullText: file.text,
  };
}

export function medicalKolLlamaParseJson(): ExtractTestDocument {
  const file = DEMO_PACK.find((f) => f.id === "medical-kol")!;
  return {
    id: "medical-kol-llamaparse",
    source_key: "medical-kol",
    filename: "medical-kol.llamaparse.json",
    title: file.title,
    source_type: file.source_type,
    stakeholder_function: file.stakeholder_function,
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    parser: "llamaparse",
    ingested_at: DEMO_JSON_INGESTED_AT,
    markdown_full: file.text,
    items: {
      pages: [
        {
          page: 1,
          markdown:
            "# CNS\n\nKOLs need to know intracranial outcomes. Limited evidence on CNS response and duration in patients with brain metastases remains an open question for medical affairs.",
          items: [
            {
              type: "heading",
              heading: "CNS",
              md: "KOLs need to know intracranial outcomes.",
            },
            {
              type: "chart",
              heading: "CNS response",
              value: "Intracranial ORR and duration not characterised in brain metastases.",
              rows: [
                ["Endpoint", "Evidence"],
                ["Intracranial ORR", "Limited evidence"],
                ["Duration of CNS response", "Open question"],
              ],
            },
          ],
        },
        {
          page: 2,
          markdown:
            "# Sequencing\n\nWe need to characterise real-world treatment sequencing after osimertinib failure. Insufficient data on where Velmara sits versus NX-441.\n\nA congress abstract on sequencing is planned for 2027, but that is dissemination, not new evidence generation.",
          items: [
            {
              type: "bullet",
              heading: "Sequencing",
              md: "We need to characterise real-world treatment sequencing after osimertinib failure. Insufficient data on where Velmara sits versus NX-441.",
            },
            {
              type: "table",
              heading: "Planned dissemination",
              rows: [["Tactic", "Year", "Evidence?"], ["Congress abstract on sequencing", "2027", "No — dissemination"]],
            },
          ],
        },
      ],
    },
  };
}

export function payerAccessLlamaParseJson(): ExtractTestDocument {
  const file = DEMO_PACK.find((f) => f.id === "payer-access")!;
  return {
    id: "payer-access-llamaparse",
    source_key: "payer-access",
    filename: "payer-access.llamaparse.json",
    title: file.title,
    source_type: file.source_type,
    stakeholder_function: file.stakeholder_function,
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    parser: "llamaparse",
    ingested_at: DEMO_JSON_INGESTED_AT,
    markdown_full: file.text,
    items: {
      pages: [
        {
          page: 1,
          markdown:
            "# Persistence\n\nAetna and UnitedHealthcare need to understand 6-month discontinuation in routine care. Limited evidence on persistence is blocking formulary.",
          items: [
            {
              type: "chart",
              heading: "6-month discontinuation",
              value: "Limited evidence on persistence is blocking formulary.",
              rows: [
                ["Payer", "Need"],
                ["Aetna", "6-month discontinuation in routine care"],
                ["UnitedHealthcare", "6-month discontinuation in routine care"],
              ],
            },
          ],
        },
        {
          page: 2,
          markdown:
            "# IRA\n\nWe need to quantify IRA net-price exposure for Velmara. Unknown whether the current budget-impact model reflects the negotiated-price scenario.\n\nA claims study for 6-month discontinuation is proposed but has not started.",
          items: [
            {
              type: "bullet",
              heading: "IRA",
              md: "We need to quantify IRA net-price exposure for Velmara. Unknown whether the current budget-impact model reflects the negotiated-price scenario.",
            },
            {
              type: "table",
              heading: "Proposed claims study",
              rows: [["Study", "Status"], ["6-month discontinuation claims", "Proposed — not started"]],
            },
          ],
        },
      ],
    },
  };
}

export function allExtractTestDocuments(): ExtractTestDocument[] {
  return [
    ...DEMO_PACK.map(demoFileToParsedJson),
    medicalKolLlamaParseJson(),
    payerAccessLlamaParseJson(),
  ];
}

export function extractTestManifest() {
  return {
    format: "iegp-extract-test-docs",
    preferred_input: "json",
    endpoint: "POST /api/extract/gaps?wait=1",
    gold_source_keys: [...new Set(DEMO_PACK.map((f) => f.id))],
    docs: DEMO_JSON_PACK.map((file) => ({
      id: file.id,
      source_key: file.source_key,
      filename: file.filename,
      href: file.href,
      title: file.title,
      source_type: file.source_type,
      stakeholder_function: file.stakeholder_function,
      flavor: file.flavor,
    })),
  };
}

export function writeDemoExtractJsonDir(dir = join(process.cwd(), "public/demo-sources/json")) {
  mkdirSync(dir, { recursive: true });
  for (const document of allExtractTestDocuments()) {
    writeFileSync(join(dir, document.filename), `${JSON.stringify(document, null, 2)}\n`);
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(extractTestManifest(), null, 2)}\n`);
}
