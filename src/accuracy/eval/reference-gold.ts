import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../../../reference/manifest.json";
import {
  scoreRecallAgainstTargets,
  type ExtractCandidates,
  type PackRecallScore,
} from "./pack-recall";

export type ReferenceManifest = typeof manifest;
export type ReferencePack = ReferenceManifest["packs"][number];

export type ReferenceGapsGold = {
  source_pack_id: string;
  source_filename: string;
  must_find_gap_ids?: string[];
  must_find_tactic_identifiers?: string[];
  gaps: unknown[];
};

export type ReferenceTacticsGold = {
  source_pack_id: string;
  source_filename: string;
  must_find_tactic_numbers?: number[];
  must_find_tactic_identifiers?: string[];
  tactics: unknown[];
};

export type ReferenceGoldBundle = {
  packId: string;
  gaps: ReferenceGapsGold;
  tactics: ReferenceTacticsGold;
};

export type ReferenceMustFindTargets = {
  gap_ids: string[];
  tactic_numbers: number[];
  tactic_identifiers: string[];
};

export type ReferencePackEvalResult = {
  packId: string;
  /** `targets_only` when no extract candidates were supplied; `scored` when recall was computed. */
  status: "targets_only" | "scored";
  pack: ReferencePack;
  targets: ReferenceMustFindTargets;
  recall?: PackRecallScore;
};

/** @deprecated Use ReferencePackEvalResult */
export type ReferencePackEvalStub = ReferencePackEvalResult;

export type AccuracyEvalReferencePackOptions = {
  candidates?: ExtractCandidates;
  /** When true and candidates omitted, score must_find IDs present in gold row payloads (oracle). */
  oracleFromGold?: boolean;
};

export function loadReferenceManifest(): ReferenceManifest {
  return manifest;
}

export function listReferencePacks(): ReferencePack[] {
  return manifest.packs;
}

export function getReferencePack(packId: string): ReferencePack | undefined {
  return manifest.packs.find((p) => p.id === packId);
}

export function referencePackDir(packId: string): string {
  return join(process.cwd(), "reference", packId);
}

export function loadReferenceGold(packId: string): ReferenceGoldBundle {
  const pack = getReferencePack(packId);
  if (!pack) {
    throw new Error(`Unknown reference pack: ${packId}`);
  }
  const dir = referencePackDir(packId);
  const gaps = JSON.parse(
    readFileSync(join(dir, pack.gold, "gaps.json"), "utf8"),
  ) as ReferenceGapsGold;
  const tactics = JSON.parse(
    readFileSync(join(dir, pack.gold, "tactics.json"), "utf8"),
  ) as ReferenceTacticsGold;
  return { packId, gaps, tactics };
}

/** Eval recall targets for extract stages (per pack, never merged). */
export function mustFindForPack(packId: string): ReferenceMustFindTargets {
  const { gaps, tactics } = loadReferenceGold(packId);
  return {
    gap_ids: gaps.must_find_gap_ids ?? [],
    tactic_numbers: tactics.must_find_tactic_numbers ?? [],
    tactic_identifiers:
      tactics.must_find_tactic_identifiers ?? gaps.must_find_tactic_identifiers ?? [],
  };
}

/**
 * Oracle candidates from filled gold rows — perfect recall when gaps/tactics arrays
 * carry the must_find identifiers (eval harness / CI smoke, not live LLM extract).
 */
export function candidatesFromGold(packId: string): ExtractCandidates {
  const { gaps, tactics } = loadReferenceGold(packId);
  const gap_ids: string[] = [];
  for (const row of gaps.gaps) {
    if (row && typeof row === "object" && "id" in row && typeof (row as { id: unknown }).id === "string") {
      gap_ids.push((row as { id: string }).id);
    }
  }
  const tactic_numbers: number[] = [];
  const tactic_identifiers: string[] = [];
  for (const row of tactics.tactics) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { number?: unknown; identifier?: unknown };
    if (typeof rec.number === "number") tactic_numbers.push(rec.number);
    if (typeof rec.identifier === "string") tactic_identifiers.push(rec.identifier);
  }
  return { gap_ids, tactic_numbers, tactic_identifiers };
}

/** Score extract candidates against a pack's must_find gold (packs never merged). */
export function scorePackRecall(packId: string, candidates: ExtractCandidates = {}): PackRecallScore {
  return scoreRecallAgainstTargets(mustFindForPack(packId), candidates);
}

/**
 * Eval runner: loads pack gold must_find targets and optionally scores extract candidates.
 * Packs are never merged — pass one packId at a time.
 */
export async function accuracyEvalReferencePack(
  packId: string,
  options: AccuracyEvalReferencePackOptions = {},
): Promise<ReferencePackEvalResult> {
  const pack = getReferencePack(packId);
  if (!pack) {
    throw new Error(`Unknown reference pack: ${packId}`);
  }
  const targets = mustFindForPack(packId);
  const candidates =
    options.candidates ?? (options.oracleFromGold ? candidatesFromGold(packId) : undefined);
  if (!candidates) {
    return { packId, status: "targets_only", pack, targets };
  }
  return {
    packId,
    status: "scored",
    pack,
    targets,
    recall: scorePackRecall(packId, candidates),
  };
}

export type { ExtractCandidates, PackRecallScore } from "./pack-recall";
export { scoreRecallAgainstTargets, sourceRecallCandidatesFromTactics } from "./pack-recall";
