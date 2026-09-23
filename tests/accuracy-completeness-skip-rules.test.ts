import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditCompleteness,
  auditCompletenessDetailed,
} from "@/accuracy/modules/completeness-audit/engine";
import {
  completenessSkipReason,
  isChapterLabelNoise,
  isHeadingOnlyNoise,
  isSiLabelNoise,
} from "@/accuracy/modules/completeness-audit/skip-rules";
import { blocksFromParsedDocument } from "@/accuracy/store/parse-store";
import { loadReferenceGold, getReferencePack, referencePackDir } from "@/accuracy/eval/reference-gold";
import { parseLocalDocument, mimeForFilename } from "@/lib/ingest/local-parse";

const src = {
  source_file_id: "src1",
  index: 0,
};

describe("completeness skip rules", () => {
  it.each([
    {
      name: "slide title kind",
      block: { kind: "heading", text: "Overview of Prioritized Evidence Gaps (SI1: Differentiation)", heading: "Title" },
      reason: "heading_only",
    },
    {
      name: "parsed title kind",
      block: { kind: "title", text: "BGB-58067 Integrated Evidence Plan", heading: "Title" },
      reason: "heading_only",
    },
    {
      name: "heading echo list item",
      block: {
        kind: "list_item",
        text: "Situational and Strategic Context",
        heading: "Situational and Strategic Context",
      },
      reason: "heading_only",
    },
    {
      name: "table of contents row",
      block: {
        kind: "list_item",
        text: "Asset Context and Purpose of the IEP",
        heading: "Table Of Contents",
      },
      reason: "heading_only",
    },
    {
      name: "deck footer chrome",
      block: { kind: "list_item", text: "Planned/ Addressed Tactics", heading: "Executive Summary" },
      reason: "heading_only",
    },
    {
      name: "abbreviation wall",
      block: {
        kind: "prose",
        text: "CDP: Clinical Development Plan; CE: Critical Priority; IIT: Investigator-Initiated Trial; NSCLC: Non-Small Cell Lung Cancer;",
        heading: "Prioritized evidence gaps",
      },
      reason: "heading_only",
    },
    {
      name: "thank-you boilerplate",
      block: {
        kind: "list_item",
        text: "Thank you to those that have contributed to this IEP!",
        heading: "Thank you",
      },
      reason: "heading_only",
    },
    {
      name: "split title fragment",
      block: {
        kind: "list_item",
        text: "was originally developed based on a single-arm, later-line (2L+) trial design and was",
        heading: "V1.0 BGB-58067 IEP DISCLAIMER",
      },
      reason: "heading_only",
    },
    {
      name: "tisle chapter divider",
      block: { kind: "list_item", text: "Advanced/Metastatic GC/GEJ", heading: "Advanced/Metastatic GC/GEJ" },
      reason: "chapter_label",
    },
    {
      name: "chapter section title",
      block: {
        kind: "list_item",
        text: "Evidence Gap Prioritization: Transversal Gaps",
        heading: "Title",
      },
      reason: "chapter_label",
    },
    {
      name: "numbered chapter toc",
      block: {
        kind: "list_item",
        text: "4. Advanced/Metastatic GC/GEJ",
        heading: "IEGP Chapter Flow",
      },
      reason: "chapter_label",
    },
    {
      name: "implementation roadmap chapter",
      block: {
        kind: "list_item",
        text: "Implementation Roadmap: Across Upper GI",
        heading: "Across Upper GI",
      },
      reason: "chapter_label",
    },
    {
      name: "SI numbered theme",
      block: {
        kind: "list_item",
        text: "SI 3: Combinations and Sequencing",
        heading: "Prioritized evidence gaps",
      },
      reason: "si_label",
    },
    {
      name: "medical strategic imperatives label",
      block: {
        kind: "list_item",
        text: "Medical Strategic Imperatives",
        heading: "Table Of Contents",
      },
      reason: "heading_only",
    },
    {
      name: "SI overview title",
      block: {
        kind: "list_item",
        text: "Overview of Prioritized Evidence Gaps (SI1: Differentiation)",
        heading: "Title",
      },
      reason: "si_label",
    },
    {
      name: "SI numbered strategy dump",
      block: {
        kind: "list_item",
        text: "1. Evidence-Based Differentiation 2. Communicate One Scientific Story 3. Competitive Medical Mindset 4.",
        heading: "Tislelizumab medical strategy",
      },
      reason: "si_label",
    },
    {
      name: "SI legend chrome",
      block: {
        kind: "list_item",
        text: "Strategic imperative(s) related to evidence gap",
        heading: "Navigating the Gap Prioritization Section",
      },
      reason: "si_label",
    },
  ])("skips $name as $reason", ({ block, reason }) => {
    expect(completenessSkipReason(block)).toBe(reason);
  });

  it("does not skip material gap statements", () => {
    const block = {
      kind: "prose" as const,
      text: "Need for RWE on long term tislelizumab efficacy in Caucasian patients to support access and comparison",
      heading: "Evidence Gaps: Transversal",
    };
    expect(completenessSkipReason(block)).toBeNull();
    expect(isHeadingOnlyNoise(block)).toBe(false);
    expect(isChapterLabelNoise(block)).toBe(false);
    expect(isSiLabelNoise(block)).toBe(false);
  });

  it("does not skip inventory-flavored tactic rows", () => {
    expect(
      completenessSkipReason({
        kind: "table_row",
        text: "Ongoing phase 3 trial of tislelizumab plus chemotherapy in 1L GC/GEJ",
        heading: "Tactics: Transversal Gaps",
      }),
    ).toBeNull();
  });

  it("does not skip NSCLC gap IDs even on SI slides", () => {
    expect(
      completenessSkipReason({
        kind: "list_item",
        text: "NSCLC_CE_04 Quantifying CNS differentiation versus competing PRMT5 inhibitors in 2L+",
        heading: "Overview of Prioritized Evidence Gaps (SI1: Differentiation)",
      }),
    ).toBeNull();
  });
});

describe("auditCompleteness applies skip rules", () => {
  it("skips heading-only and chapter/SI chrome while flagging real gaps", () => {
    const result = auditCompletenessDetailed({
      blocks: [
        {
          id: "h1",
          ...src,
          kind: "heading",
          text: "Evidence Gap Prioritization: Advanced/Metastatic ESCC",
          heading: "Title",
        },
        {
          id: "ch1",
          ...src,
          index: 1,
          kind: "list_item",
          text: "Advanced/Metastatic ESCC",
          heading: "Advanced/Metastatic ESCC",
        },
        {
          id: "si1",
          ...src,
          index: 2,
          kind: "list_item",
          text: "SI 1: Differentiation in MTAP-deleted NSCLC",
          heading: "Medical strategic imperatives",
        },
        {
          id: "toc1",
          ...src,
          index: 3,
          kind: "list_item",
          text: "Prioritized Evidence Gaps",
          heading: "Table Of Contents",
        },
        {
          id: "gap1",
          ...src,
          index: 4,
          kind: "prose",
          text: "Need for pharmacokinetics, clinical trial and/or RWE to support a flexible dosing schedule",
          heading: "Evidence Gaps: Across Lung",
        },
      ],
      claims: [],
    });
    expect(result.flags.map((f) => f.block_id)).toEqual(["gap1"]);
    expect(result.skipped_noise).toBeGreaterThanOrEqual(4);
    expect(result.skipped_by_reason.heading_only).toBeGreaterThanOrEqual(2);
    expect(result.skipped_by_reason.si_label).toBeGreaterThanOrEqual(1);
  });

  it("auditCompleteness wrapper still returns only flags", () => {
    const flags = auditCompleteness({
      blocks: [
        {
          id: "h1",
          ...src,
          kind: "heading",
          text: "Overview of Prioritized Evidence Gaps (SI2: Biomarkers)",
        },
        {
          id: "g1",
          ...src,
          index: 1,
          kind: "prose",
          text: "Unmet evidence need for comparative effectiveness in elderly NSCLC patients after progression.",
        },
      ],
      claims: [],
    });
    expect(flags.map((f) => f.block_id)).toEqual(["g1"]);
  });
});

describe("gold PPTX completeness noise filters", () => {
  it("keeps Tisle full-deck Review inbox well below unfiltered hundreds", async () => {
    const packId = "beone-tislelizumab-iegp";
    const pack = getReferencePack(packId);
    expect(pack).toBeTruthy();
    const sourceRel = pack!.source_file.replace(/^sources\//, "");
    const sourcePath = join(referencePackDir(packId), pack!.source_file);
    const buffer = readFileSync(sourcePath);
    const document = await parseLocalDocument({
      filename: sourceRel,
      buffer,
      mime: mimeForFilename(sourceRel),
    });
    const blocks = blocksFromParsedDocument({
      workspace_id: "ws-gold",
      source_file_id: "src-gold",
      blocks: document.blocks,
    });
    const gold = loadReferenceGold(packId);
    const claims = [
      ...(gold.gaps.gaps as Array<{ statement?: string }>)
        .filter((g) => g.statement?.trim())
        .map((g, i) => ({
          id: `gap-${i}`,
          claim_type: "gap" as const,
          statement: g.statement!.trim(),
        })),
      ...(gold.tactics.tactics as Array<{ title?: string }>)
        .filter((t) => t.title?.trim())
        .map((t, i) => ({
          id: `tac-${i}`,
          claim_type: "tactic" as const,
          statement: t.title!.trim(),
        })),
    ];
    const unfilteredKinds = new Set(["prose", "table_row", "list_item", "heading"]);
    const longEnough = blocks.filter((b) => b.text.replace(/\s+/g, " ").trim().length >= 24);
    const unfilteredEligible = longEnough.filter((b) => unfilteredKinds.has(b.kind)).length;
    const result = auditCompletenessDetailed({ blocks, claims });
    expect(unfilteredEligible).toBeGreaterThan(800);
    expect(result.skipped_noise).toBeGreaterThan(200);
    expect(result.flags.length).toBeLessThan(200);
    expect(result.flags.length).toBeLessThan(unfilteredEligible / 4);
    expect(result.flags.every((f) => f.kind !== "heading")).toBe(true);
  }, 30_000);
});
