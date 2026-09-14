import { classifyStatement, headingSuggestsGaps } from "@/lib/extract/classify";
import {
  STRATEGY_BY_VERSION,
} from "@/lib/seed/corpus";
import type {
  CanonicalInsight,
  ExtractStrategy,
  ParsedBlock,
  ParsedDocument,
  PromptVersion,
} from "@/lib/schema";
import {
  atomize,
  hashId,
  looksLikeClaim,
  statementSimilarity,
  stripBullet,
} from "@/lib/text";

const NEXT_VERSION: Record<string, PromptVersion> = {
  "v1.0-baseline": "v1.1-atomic",
  "v1.1-atomic": "v1.2-gap-sensitive",
  "v1.2-gap-sensitive": "v1.3-cross-functional",
  "v1.3-cross-functional": "v1.3-cross-functional",
};

export function strategyFor(version: string): ExtractStrategy {
  return STRATEGY_BY_VERSION[version] ?? "full";
}

export function nextPromptVersion(version: string): PromptVersion {
  return NEXT_VERSION[version] ?? "v1.3-cross-functional";
}

function kindsFor(strategy: ExtractStrategy): ParsedBlock["kind"][] {
  if (strategy === "bullet-only") return ["bullet"];
  if (strategy === "claim-split") return ["bullet"];
  return ["bullet", "paragraph", "table_cell", "cell"];
}

function splitClaims(text: string, strategy: ExtractStrategy): string[] {
  const cleaned = stripBullet(text);
  if (strategy === "bullet-only") return [cleaned];
  return atomize(cleaned);
}

function withHeadingContext(
  statement: string,
  heading: string | undefined,
  strategy: ExtractStrategy,
): string {
  if (strategy !== "full" || !heading) return statement;
  if (
    statement.length < 80 &&
    !statement.toLowerCase().includes(heading.toLowerCase().split(" ")[0] ?? "")
  ) {
    if (
      /cns|intracranial|brain/i.test(heading) &&
      /limited|n=\d+/i.test(statement)
    ) {
      return `${statement.replace(/\.$/, "")} in the CNS / brain-mets package.`;
    }
  }
  return statement;
}

function confidenceFor(statement: string, quote: string): number {
  let c = 0.62;
  if (/\d/.test(statement)) c += 0.12;
  if (
    /aetna|united|horizon|medicaid|velmara|nx-441|cms|cns/i.test(statement)
  ) {
    c += 0.1;
  }
  if (quote.length > 20) c += 0.08;
  return Math.min(0.96, c);
}

export function proposeInsights(
  documents: ParsedDocument[],
  promptVersion: string,
  extractedAt = new Date().toISOString(),
): CanonicalInsight[] {
  const strategy = strategyFor(promptVersion);
  const allowed = new Set(kindsFor(strategy));
  const insights: CanonicalInsight[] = [];

  for (const doc of documents) {
    for (const block of doc.blocks) {
      if (!allowed.has(block.kind)) continue;
      if (block.kind === "title") continue;
      const gapHeading = headingSuggestsGaps(block.heading);
      const claims = splitClaims(block.text, strategy);
      for (const raw of claims) {
        const statement = withHeadingContext(raw, block.heading, strategy);
        if (!looksLikeClaim(statement)) continue;
        if (strategy === "bullet-only" && block.kind !== "bullet") continue;
        let classification = classifyStatement(statement, block.heading);
        if (
          (strategy === "gap-scan" || strategy === "full") &&
          gapHeading &&
          classification === "known"
        ) {
          classification = "unknown";
        }
        const id = hashId("INS", `${doc.id}|${block.id}|${statement}`);
        insights.push({
          id,
          statement,
          evidence_quote: block.text.slice(0, 400),
          source_document_id: doc.id,
          source_location: block.location,
          stakeholder_function: doc.stakeholder_function,
          theme_ids: [],
          confidence: confidenceFor(statement, block.text),
          classification,
          knowledge_state: {
            corroborated_by: [],
            contradicted_by: [],
            evidence_strength: "single_source",
          },
          tags: [doc.stakeholder_function, classification],
          extracted_at: extractedAt,
          extractor_prompt_version: promptVersion,
          status: "accepted",
        });
      }
    }
  }

  return dedupInsights(insights, strategy);
}

function dedupInsights(
  insights: CanonicalInsight[],
  strategy: ExtractStrategy,
): CanonicalInsight[] {
  if (strategy !== "full") return insights;
  const kept: CanonicalInsight[] = [];
  for (const insight of insights) {
    const dup = kept.find(
      (k) => statementSimilarity(k.statement, insight.statement) >= 0.9,
    );
    if (!dup) kept.push(insight);
  }
  return kept;
}

export function groundAgainstSource(
  statement: string,
  documents: ParsedDocument[],
): number {
  let best = 0;
  for (const doc of documents) {
    for (const block of doc.blocks) {
      best = Math.max(best, statementSimilarity(statement, block.text));
    }
  }
  return best;
}
