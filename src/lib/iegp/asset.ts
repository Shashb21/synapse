import type { Asset } from "./types";

export type AssetDetails = Pick<Asset, "name" | "inn" | "indication" | "geography">;

const FIELDS = ["name", "inn", "indication", "geography"] as const;

/**
 * The asset details someone has actually entered. A blank workspace's asset
 * row holds empty strings (the schema needs a value); those are not data, so
 * they are left out rather than shown or sent to a model as if they were.
 * Undefined when nothing is entered yet.
 */
export function enteredAssetDetails(asset: Partial<AssetDetails> | null | undefined): Partial<AssetDetails> | undefined {
  if (!asset) return undefined;
  const out: Partial<AssetDetails> = {};
  for (const field of FIELDS) {
    const value = asset[field]?.trim();
    if (value) out[field] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** "inn · indication · geography", only the parts that are filled in; "" when none are. */
export function assetSubtitle(asset: Partial<AssetDetails>): string {
  const entered = enteredAssetDetails(asset) ?? {};
  return [entered.inn, entered.indication, entered.geography].filter(Boolean).join(" · ");
}
