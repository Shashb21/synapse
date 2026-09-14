import { classifyStatement } from "@/lib/extract/classify";
import { PROMPT_REGISTRY } from "@/lib/extract/prompts";
import { completeJson } from "@/lib/llm/anthropic";
import type {
  CanonicalInsight,
  InsightClass,
  ParsedDocument,
  SourceLocation,
} from "@/lib/schema";
import { hashId, looksLikeClaim } from "@/lib/text";
import { z } from "zod";

const CLAUDE_VERSION = "v1.4-claude";

const llmInsightSchema = z.object({
  statement: z.string(),
  evidence_quote: z.string(),
  source_location: z
    .object({
      kind: z.string().optional(),
      ref: z.string().optional(),
    })
    .optional(),
  classification: z.enum(["known", "unknown", "opportunity"]).optional(),
  confidence: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

const payloadSchema = z.object({
  insights: z.array(llmInsightSchema),
});

function coerceLocation(
  raw: { kind?: string; ref?: string } | undefined,
  fallback: SourceLocation,
): SourceLocation {
  const kind = raw?.kind;
  const allowed: SourceLocation["kind"][] = [
    "slide",
    "page",
    "sheet",
    "section",
    "cell",
  ];
  if (kind && (allowed as string[]).includes(kind) && raw?.ref) {
    return { kind: kind as SourceLocation["kind"], ref: raw.ref };
  }
  if (raw?.ref) return { ...fallback, ref: raw.ref };
  return fallback;
}

function packDocument(doc: ParsedDocument): string {
  const blocks = doc.blocks
    .map(
      (b) =>
        `[${b.id} | ${b.location.kind} ${b.location.ref} | ${b.kind}${b.heading ? ` | ${b.heading}` : ""}]\n${b.text}`,
    )
    .join("\n\n");
  return `Document id: ${doc.id}
Filename: ${doc.filename}
Title: ${doc.title}
Stakeholder function (do not override): ${doc.stakeholder_function}
Parser: ${doc.parser}

Source blocks:
${blocks}`;
}

export async function proposeWithClaude(
  documents: ParsedDocument[],
  extractedAt = new Date().toISOString(),
): Promise<CanonicalInsight[]> {
  const system =
    PROMPT_REGISTRY.find((p) => p.version === "v1.3-cross-functional")
      ?.system_prompt ?? "";
  const insights: CanonicalInsight[] = [];

  for (const doc of documents) {
    const json = await completeJson({
      system: `${system}

Charts and graphics: if a block kind is chart or a table of series/values, treat visible numbers, axis labels, and legends as source text. Do not interpolate missing years or unlabelled bars.`,
      user: packDocument(doc),
    });
    const parsed = payloadSchema.parse(json);
    for (const row of parsed.insights) {
      const statement = row.statement.trim();
      if (!looksLikeClaim(statement)) continue;
      const evidence = row.evidence_quote.trim() || statement;
      const classification: InsightClass =
        row.classification ?? classifyStatement(statement);
      const fallbackLoc = doc.blocks[0]?.location ?? {
        kind: "section" as const,
        ref: "block 1",
      };
      insights.push({
        id: hashId("INS", `${doc.id}|claude|${statement}`),
        statement,
        evidence_quote: evidence.slice(0, 500),
        source_document_id: doc.id,
        source_location: coerceLocation(row.source_location, fallbackLoc),
        stakeholder_function: doc.stakeholder_function,
        theme_ids: [],
        confidence: Math.max(0, Math.min(1, row.confidence ?? 0.78)),
        classification,
        knowledge_state: {
          corroborated_by: [],
          contradicted_by: [],
          evidence_strength: "single_source",
        },
        tags: [doc.stakeholder_function, classification, "claude", ...(row.tags ?? [])],
        extracted_at: extractedAt,
        extractor_prompt_version: CLAUDE_VERSION,
        status: "accepted",
      });
    }
  }

  return insights;
}

export const CLAUDE_PROMPT_VERSION = CLAUDE_VERSION;
