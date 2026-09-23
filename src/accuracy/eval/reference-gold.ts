import manifest from "../../../reference/manifest.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export type ReferencePackEvalStub = {
  packId: string;
  status: "stub";
  pack: ReferencePack;
  targets: ReferenceMustFindTargets;
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
 * Eval runner entrypoint (stub): loads manifest + gold must_find targets for one pack.
 * Pipeline recall scoring is wired in later workstreams.
 */
export async function accuracyEvalReferencePack(
  packId: string,
): Promise<ReferencePackEvalStub> {
  const pack = getReferencePack(packId);
  if (!pack) {
    throw new Error(`Unknown reference pack: ${packId}`);
  }
  return {
    packId,
    status: "stub",
    pack,
    targets: mustFindForPack(packId),
  };
}
