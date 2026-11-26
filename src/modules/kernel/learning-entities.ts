import { db } from "./db";
import { assets, sources, tactics } from "@/lib/iegp/schema";

/** Only names used by the scrubber are loaded in the recorded workspace. */
export async function readLearningEntityProjection() {
  const [assetRows, sourceNames, tacticNames] = await Promise.all([
    db().select({ name: assets.name, inn: assets.inn, planning_context: assets.planning_context }).from(assets).limit(1),
    db().select({ name: sources.title }).from(sources),
    db().select({ name: tactics.name }).from(tactics),
  ]);
  return { asset: assetRows[0], names: [...sourceNames, ...tacticNames].map((row) => row.name) };
}
