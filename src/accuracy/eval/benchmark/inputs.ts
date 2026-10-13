/** Prepare immutable complete-source benchmark packs and evaluator-only gold locally.
 * Hashes bind input bytes, parser/version metadata and reviewed reference content.
 * No persistence, database, environment or provider access occurs here.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parsedBlockSchema, sourceLocationSchema, type ParsedBlock } from "@/lib/schema";
import { parseLocalDocument } from "@/lib/ingest/local-parse";
import type { BenchmarkConfig } from "./contracts";

const identity = z.string().min(1).refine((v) => v.trim() === v && v.trim().length > 0);
const timestamp = z.iso.datetime({ offset: true });
const reviewSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("approved"), reviewerId: identity, reviewedAt: timestamp, referenceVersion: identity }),
]);
const itemSchema = z.strictObject({
  id: identity, statement: identity, blockIds: z.array(identity),
  // Original reference row/identifiers may be retained here, only in private runtime artifacts.
  reference: z.record(z.string(), z.json()).optional(),
  parsingLoss: z.strictObject({ reason: identity, location: sourceLocationSchema }).optional(),
});
export type GoldReview = z.infer<typeof reviewSchema>;
export type FrozenGoldItem = z.infer<typeof itemSchema>;
export type FreezeReferencePackInput = {
  packId: string;
  filename: string;
  originalFile: Buffer;
  /** Reuse the preflight configuration's source/version contracts; no readiness claim here. */
  config: Pick<BenchmarkConfig, "sources" | "referenceVersion" | "sourceCodeVersion">;
  parserVersion: string;
  frozenAt: string;
  /** Supply an already prepared complete representation, or use the pure local parser. */
  blocks?: ParsedBlock[];
  gold: { needs: FrozenGoldItem[]; tactics: FrozenGoldItem[]; needsReview?: GoldReview; tacticsReview?: GoldReview };
};
export type FrozenGoldStage = {
  items: FrozenGoldItem[];
  parsingLossIds: string[];
  review: GoldReview;
};
export type FrozenReferencePack = {
  packId: string; filename: string; referenceVersion: string; sourceCodeVersion: string;
  parserVersion: string; frozenAt: string;
  originalFileHash: string; sourceHash: string; referenceHash: string; packHash: string;
  /** Extractors receive this source only. Gold remains evaluator-only. */
  source: { blocks: ParsedBlock[] };
  gold: { needs: FrozenGoldStage; tactics: FrozenGoldStage };
};

/** Serialize JSON-like value with sorted object keys; returns stable text for hashing. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
/** Return lowercase SHA-256 of canonical JSON-like input; serialization errors propagate. */
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Recursively freeze supplied snapshot in place and return it; freeze errors propagate. */
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
/** Require distinct supplied identities; returns void or throws Error for duplicates. */
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate identity");
}

/** Pure local preparation: no persistence, database, environment or provider calls.
 * Hashes are lowercase SHA-256. Output is detached and recursively frozen.
 * The caller owns complete-source attestation and human review authenticity.
 * @param input Original bytes, complete source configuration, parser metadata and separate gold stages.
 * @returns Detached recursively frozen pack, with source and reference hashes and review state.
 * @throws Validation errors for invalid identities, source hashes/counts, gold links or reviews;
 * local document parser failures propagate when blocks are not supplied.
 */
export async function freezeReferencePack(input: FreezeReferencePackInput): Promise<FrozenReferencePack> {
  const packId = identity.parse(input.packId);
  const filename = identity.parse(input.filename);
  const referenceVersion = identity.parse(input.config.referenceVersion);
  const sourceCodeVersion = identity.parse(input.config.sourceCodeVersion);
  const parserVersion = identity.parse(input.parserVersion);
  const frozenAt = timestamp.parse(input.frozenAt);
  // Snapshot before any async preparation, so caller mutation cannot race the freeze.
  const originalFile = Buffer.from(input.originalFile);
  const suppliedBlocks = input.blocks === undefined ? undefined : structuredClone(input.blocks);
  const goldInput = structuredClone(input.gold);
  const sources = structuredClone(input.config.sources);
  unique(sources.map((source) => identity.parse(source.packId)));
  const sourceConfig = sources.find((source) => source.packId === packId);
  const originalFileHash = createHash("sha256").update(originalFile).digest("hex");
  if (!sourceConfig || !sourceConfig.complete || sourceConfig.hash !== originalFileHash) {
    throw new Error("Missing, incomplete or mismatched source configuration");
  }
  const prepared = suppliedBlocks ?? (await parseLocalDocument({ filename, buffer: originalFile })).blocks;
  const blocks = z.array(parsedBlockSchema.extend({ id: identity, text: z.string().refine((v) => v.trim().length > 0) })).min(1).parse(prepared);
  // Text can include leading/trailing whitespace: preserve it verbatim, unlike identities.
  unique(blocks.map((block) => block.id));
  if (blocks.length !== sourceConfig.blocks) throw new Error("Complete block count mismatch");
  const blockIds = new Set(blocks.map((block) => block.id));
  /** Validate gold rows/review against source links; return frozen-pack stage data or throw. */
  function stage(rows: FrozenGoldItem[], suppliedReview?: GoldReview): FrozenGoldStage {
    const items = z.array(itemSchema).parse(rows);
    unique(items.map((item) => item.id));
    for (const item of items) {
      unique(item.blockIds);
      if (item.blockIds.some((id) => !blockIds.has(id))) throw new Error("Invalid gold block link");
      if (item.parsingLoss ? item.blockIds.length !== 0 : item.blockIds.length === 0) {
        throw new Error("Gold needs valid support or an explicit parsing loss");
      }
    }
    const review = reviewSchema.parse(suppliedReview ?? { status: "pending" });
    if (review.status === "approved" && (review.referenceVersion !== referenceVersion || Date.parse(review.reviewedAt) > Date.parse(frozenAt))) {
      throw new Error("Review version or timestamp mismatch");
    }
    return { items, parsingLossIds: items.filter((item) => item.parsingLoss).map((item) => item.id), review };
  }
  const source = { blocks };
  const gold = { needs: stage(goldInput.needs, goldInput.needsReview), tactics: stage(goldInput.tactics, goldInput.tacticsReview) };
  const result = {
    packId, filename, referenceVersion, sourceCodeVersion, parserVersion, frozenAt,
    originalFileHash, sourceHash: hash(source), referenceHash: hash({ packId, referenceVersion, gold }), source, gold,
  };
  return freezeDeep({ ...result, packHash: hash(result) });
}
