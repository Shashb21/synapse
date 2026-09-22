import type { StageId } from "@/modules/kernel/contracts";
import type { CuratedEvalCase } from "./types";
import {
  goldMetaForSource,
  parsedDocumentIdForSource,
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

export async function curatedS2Cases(): Promise<
  CuratedEvalCase<{ document_ids: string[]; dry_run: boolean }>[]
> {
  const out: CuratedEvalCase<{ document_ids: string[]; dry_run: boolean }>[] = [];
  for (const source of sourcesForStage("S2")) {
    const document_id = await parsedDocumentIdForSource(source.source_id);
    if (!document_id) continue;
    out.push({
      name: `${source.source_id} · ${source.label}`,
      input: { document_ids: [document_id], dry_run: true },
      gold: goldMetaForSource(source),
    });
  }
  return out;
}

export async function curatedS3Cases(): Promise<
  CuratedEvalCase<{ document_ids: string[]; dry_run: boolean }>[]
> {
  return (await curatedS2Cases()).filter((caseRow) => caseRow.gold?.source_id === "SRC-INT-MED");
}

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
