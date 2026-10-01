/** Gold-only, deterministic evaluator for isolated accuracy experiments. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getReferencePack, loadReferenceGold, referencePackDir } from "./reference-gold";

/** Versioned so matching behaviour remains reproducible across experiment exports. */
export const EXPERIMENT_EVALUATOR_VERSION = "experiment-evaluator-v1";
/** Evaluator-v1 word-set overlap threshold for a partial text match. */
export const EVALUATOR_V1_PARTIAL_WORD_OVERLAP = 0.6;

export type ExperimentItemOutcome = {
  outcome: "found" | "partial" | "missed" | "wrong";
  gold_item_key?: string;
  model_item_index?: number;
  reason: string;
};
export type ExperimentExactScore = { found: number; partial: number; missed: number; wrong: number; precision: number; recall: number; f1: number };
export type ExperimentVersionEvaluation = {
  evaluator_version: typeof EXPERIMENT_EVALUATOR_VERSION;
  pack_id: string;
  pack_fingerprint: string;
  call_kind: string;
  status: "scored" | "gold_not_applicable" | "invalid_output" | "model_error";
  output_shape: { valid: boolean; item_field?: "gaps" | "tactics"; item_count?: number };
  outcomes: ExperimentItemOutcome[];
  errors: string[];
  score?: ExperimentExactScore;
};

type GoldItem = { key: string; text: string; stable_id?: string };
type ModelItem = { index: number; text: string; stable_id?: string };

function normalize(text: string): string { return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
function overlap(a: string, b: string): number {
  const left = new Set(normalize(a).split(" ").filter(Boolean));
  const right = new Set(normalize(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let common = 0; for (const word of left) if (right.has(word)) common++;
  return common / Math.max(left.size, right.size);
}

/** SHA-256 identity for the selected manifest entry and unparsed gold bytes. */
export function experimentPackFingerprint(pack_id: string): string {
  const pack = getReferencePack(pack_id);
  if (!pack) throw new Error(`Unknown reference pack: ${pack_id}`);
  const dir = join(referencePackDir(pack_id), pack.gold);
  const bytes = [JSON.stringify(pack), readFileSync(join(dir, "gaps.json")), readFileSync(join(dir, "tactics.json"))];
  return createHash("sha256").update(bytes[0]).update(bytes[1]).update(bytes[2]).digest("hex");
}

function goldItems(pack_id: string, call_kind: string): GoldItem[] | null {
  const gold = loadReferenceGold(pack_id);
  if (call_kind === "need_extract") return gold.gaps.gaps.flatMap((raw) => {
    const item = raw as Record<string, unknown>; const text = typeof item.statement === "string" ? item.statement : null;
    if (!text) return []; const stable_id = typeof item.id === "string" ? item.id : undefined;
    return [{ key: stable_id ?? text, text, stable_id }];
  });
  if (call_kind === "inventory_extract") return gold.tactics.tactics.flatMap((raw) => {
    const item = raw as Record<string, unknown>; const text = typeof item.title === "string" ? item.title : null;
    if (!text) return []; const identifier = typeof item.identifier === "string" ? item.identifier : typeof item.number === "number" ? String(item.number) : undefined;
    return [{ key: identifier ?? text, text, stable_id: identifier }];
  });
  return null;
}

function modelItems(output: unknown, field: "gaps" | "tactics"): ModelItem[] | string {
  if (!output || typeof output !== "object" || !Array.isArray((output as Record<string, unknown>)[field])) return `Expected output.${field} to be an array.`;
  return ((output as Record<string, unknown>)[field] as unknown[]).map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Expected output.${field}[${index}] to be an object.`);
    const item = raw as Record<string, unknown>;
    const text = field === "gaps" ? item.statement : item.name;
    if (typeof text !== "string" || !text.trim()) throw new Error(`Expected output.${field}[${index}] to contain a non-empty ${field === "gaps" ? "statement" : "name"}.`);
    if (field === "tactics" && typeof item.id !== "string") throw new Error(`Expected output.tactics[${index}].id to be a string.`);
    if (field === "gaps" && item.external_id !== undefined && item.external_id !== null && typeof item.external_id !== "string") throw new Error(`Expected output.gaps[${index}].external_id to be a string or null.`);
    // Inventory tactic ids are generated per run and cannot identify a gold tactic.
    const stable_id = field === "gaps" && typeof item.external_id === "string" ? item.external_id : undefined;
    return { index, text, stable_id };
  });
}

/** Evaluate one model snapshot. Only this module reads curated gold JSON. */
export function evaluateExperimentVersion(args: { pack_id: string; call_kind: string; output: unknown; output_error?: string }): ExperimentVersionEvaluation {
  const pack_fingerprint = experimentPackFingerprint(args.pack_id);
  const base = { evaluator_version: EXPERIMENT_EVALUATOR_VERSION, pack_id: args.pack_id, pack_fingerprint, call_kind: args.call_kind } as const;
  if (args.output_error) return { ...base, status: "model_error", output_shape: { valid: false }, outcomes: [], errors: [args.output_error] };
  const gold = goldItems(args.pack_id, args.call_kind);
  if (!gold) {
    const valid = Boolean(args.output && typeof args.output === "object" && !Array.isArray(args.output));
    return valid ? { ...base, status: "gold_not_applicable", output_shape: { valid }, outcomes: [], errors: [] }
      : { ...base, status: "invalid_output", output_shape: { valid }, outcomes: [], errors: ["Expected output to be an object."] };
  }
  const field = args.call_kind === "need_extract" ? "gaps" : "tactics";
  let model: ModelItem[] | string;
  try { model = modelItems(args.output, field); } catch (error) { return { ...base, status: "invalid_output", output_shape: { valid: false, item_field: field }, outcomes: [], errors: [error instanceof Error ? error.message : "Invalid output item."] }; }
  if (typeof model === "string") return { ...base, status: "invalid_output", output_shape: { valid: false, item_field: field }, outcomes: [], errors: [model] };
  const unmatchedGold = new Set(gold.map((_, index) => index)); const outcomes: ExperimentItemOutcome[] = [];
  for (const item of model) {
    let match = [...unmatchedGold].find((index) => item.stable_id && gold[index].stable_id === item.stable_id);
    if (match === undefined) match = [...unmatchedGold].find((index) => normalize(gold[index].text) === normalize(item.text));
    if (match === undefined) match = [...unmatchedGold].find((index) => overlap(gold[index].text, item.text) >= EVALUATOR_V1_PARTIAL_WORD_OVERLAP);
    if (match === undefined) { outcomes.push({ outcome: "wrong", model_item_index: item.index, reason: "No unmatched gold item matched this model item." }); continue; }
    const selected = gold[match]; unmatchedGold.delete(match);
    const exact = normalize(selected.text) === normalize(item.text);
    outcomes.push({ outcome: exact ? "found" : "partial", gold_item_key: selected.key, model_item_index: item.index,
      reason: exact ? "Stable ID/text matched exactly." : item.stable_id === selected.stable_id ? "Stable ID matched but text differed." : `Word-set overlap met ${EVALUATOR_V1_PARTIAL_WORD_OVERLAP}.` });
  }
  for (const index of unmatchedGold) outcomes.push({ outcome: "missed", gold_item_key: gold[index].key, reason: "No model item matched this gold item." });
  const found = outcomes.filter((item) => item.outcome === "found").length; const partial = outcomes.filter((item) => item.outcome === "partial").length;
  const missed = outcomes.filter((item) => item.outcome === "missed").length; const wrong = outcomes.filter((item) => item.outcome === "wrong").length;
  const precision = found + wrong === 0 ? 0 : found / (found + wrong); const recall = gold.length === 0 ? 1 : found / gold.length;
  return { ...base, status: "scored", output_shape: { valid: true, item_field: field, item_count: model.length }, outcomes, errors: [], score: { found, partial, missed, wrong, precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) } };
}
