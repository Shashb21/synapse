import type { StageId } from "@/modules/kernel/contracts";
import { demoSourceById } from "@/lib/iegp/demo-pack";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import type { CuratedGoldMeta } from "./types";

/** Maps domain source ids to bundled demo pack entries when the full seed is not loaded. */
export const SOURCE_TO_DEMO_ID: Record<string, string> = {
  "SRC-INT-MED": "medical-kol",
  "SRC-INT-HEOR": "heor-interview",
  "SRC-INT-ACCESS": "payer-access",
  "SRC-TLR-001": "tlr",
};

/**
 * Curated Velmara gold pack (v1). Statements are grounded in the demo seed;
 * see repo `docs/sdlc/12-gold-set.md` for the human inventory.
 */
export const VELMARA_CURATED_PACK = "velmara-curated-v1";

type SourceGold = {
  source_id: string;
  label: string;
  stages: StageId[];
  must_match?: string[];
  parse_min_blocks?: number;
  parse_min_need_cues?: number;
};

export const CURATED_SOURCES: SourceGold[] = [
  {
    source_id: "SRC-INT-MED",
    label: "KOL insights — medical affairs",
    stages: ["S1", "S2", "S3"],
    must_match: ["intracranial", "brain metastases", "sequencing"],
    parse_min_blocks: 4,
    parse_min_need_cues: 1,
  },
  {
    source_id: "SRC-INT-HEOR",
    label: "HEOR stakeholder interview",
    stages: ["S1", "S2"],
    must_match: ["economic", "elderly", "65"],
    parse_min_blocks: 4,
    parse_min_need_cues: 1,
  },
  {
    source_id: "SRC-INT-ACCESS",
    label: "Market access ad board",
    stages: ["S1", "S2"],
    must_match: ["discontinuation", "Aetna", "IRA"],
    parse_min_blocks: 3,
    parse_min_need_cues: 1,
  },
  {
    source_id: "SRC-TLR-001",
    label: "TLR internal deck",
    stages: ["S1", "S2"],
    must_match: ["emergency", "caregiver"],
    parse_min_blocks: 3,
  },
];

export async function parsedDocumentIdForSource(source_id: string): Promise<string | null> {
  const documents = await listParsedDocuments();
  const match = documents.find((doc) => doc.source_id === source_id);
  return match?.id ?? null;
}

export async function sourceFileIdForSource(source_id: string): Promise<string | null> {
  const files = await listSourceFiles();
  const direct = files.find((file) => file.source_id === source_id);
  if (direct) return direct.id;
  const demoId = SOURCE_TO_DEMO_ID[source_id];
  const demo = demoId ? demoSourceById(demoId) : undefined;
  if (demo) {
    const byName = files.find((file) => file.filename === demo.filename);
    if (byName) return byName.id;
  }
  const documents = await listParsedDocuments();
  const document = documents.find((doc) => doc.source_id === source_id);
  if (document?.file_id) return document.file_id;
  return null;
}

export function goldMetaForSource(source: SourceGold): CuratedGoldMeta {
  return {
    pack: VELMARA_CURATED_PACK,
    source_id: source.source_id,
    must_match: source.must_match,
    parse_min_blocks: source.parse_min_blocks,
    parse_min_need_cues: source.parse_min_need_cues,
  };
}

export function sourcesForStage(stage: StageId): SourceGold[] {
  return CURATED_SOURCES.filter((row) => row.stages.includes(stage));
}
