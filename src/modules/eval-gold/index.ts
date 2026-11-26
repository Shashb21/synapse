import type { IegpState } from "@/lib/iegp/types";
import { loadState } from "@/lib/iegp/store";
import { withEvaluationIsolation } from "@/modules/kernel/evaluation-isolation";
import { listExtractionDocuments, listParsedDocuments, type ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import type { StageId } from "@/modules/kernel/contracts";
import type { CuratedEvalCase } from "./types";
import {
  extractionGold,
  goldMetaForSource,
  sourceFileIdForSource,
  sourcesForStage,
} from "./velmara-curated";

export type { CuratedEvalCase, CuratedGoldMeta } from "./types";
export { scoreMustMatch } from "./types";
export { VELMARA_CURATED_PACK } from "./velmara-curated";
export { CURATED_SOURCES, sourcesForStage } from "./velmara-curated";

export async function curatedS1Cases(): Promise<CuratedEvalCase<{ file_ids: string[]; dry_run: boolean }>[]> {
  const out: CuratedEvalCase<{ file_ids: string[]; dry_run: boolean }>[] = [];
  for (const source of sourcesForStage("S1")) {
    const file_id = await sourceFileIdForSource(source.source_id);
    if (!file_id) continue;
    out.push({
      name: `${source.source_id} · ${source.label}`,
      input: { file_ids: [file_id], dry_run: true },
      gold: goldMetaForSource(source),
    });
  }
  return out;
}

type ExtractionStage = "S2" | "S3";
type ExtractionInput = { document_ids?: string[]; dry_run: boolean };
type ExtractionCase = CuratedEvalCase<ExtractionInput>;

function extractionCase(document: ParsedDocumentRecord): ExtractionCase {
  return { name: document.source_id, input: { document_ids: [document.id], dry_run: true } };
}

export function extractionEvalCases(stage: ExtractionStage) {
  return {
    async cases(facts?: Record<string, unknown>): Promise<ExtractionCase[]> {
      const documents = facts ? (facts.documents as ParsedDocumentRecord[]) : await listParsedDocuments();
      const candidates = sourcesForStage(stage).flatMap((source) => {
        const document = documents.find((row) => row.source_id === source.source_id);
        return document ? [document] : [];
      });
      return (candidates.length ? candidates : documents.slice(0, 3)).map(extractionCase);
    },
    goldForCase(test: ExtractionCase, facts: Record<string, unknown>) {
      const documents = facts.documents as ParsedDocumentRecord[];
      const sources = (facts.state as IegpState).sources;
      const ids = test.input.document_ids;
      if (ids?.length !== 1) return;
      const document = documents.find((row) => row.id === ids[0]);
      if (document) return extractionGold(stage, document, sources);
    },
  };
}

async function curatedExtractionCases(stage: ExtractionStage): Promise<ExtractionCase[]> {
  return withEvaluationIsolation(async () => {
    const harness = extractionEvalCases(stage);
    const facts = { documents: await listExtractionDocuments(), state: await loadState() };
    return (await harness.cases(facts)).flatMap((test) => {
      const gold = harness.goldForCase(test, facts);
      return gold ? [{ ...test, gold }] : [];
    });
  });
}

export const curatedS2Cases = () => curatedExtractionCases("S2");
export const curatedS3Cases = () => curatedExtractionCases("S3");

export async function curatedCasesForStage(stage: StageId): Promise<CuratedEvalCase<unknown>[]> {
  if (stage === "S1") return curatedS1Cases();
  if (stage === "S2") return curatedS2Cases();
  if (stage === "S3") return curatedS3Cases();
  if (stage === "S4") {
    return [{ name: "velmara-workspace-graph", input: { max_per_gap: 6, dry_run: true }, gold: { pack: "velmara-curated-v1", source_id: "workspace" } }];
  }
  if (stage === "S6" || stage === "S7" || stage === "S8" || stage === "S9" || stage === "S10") {
    return [{ name: `velmara-${stage.toLowerCase()}`, input: { dry_run: true }, gold: { pack: "velmara-curated-v1", source_id: stage } }];
  }
  return [];
}
