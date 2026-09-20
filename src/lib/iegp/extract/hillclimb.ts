import { statementSimilarity, round4 } from "@/lib/text";
import { judgeCandidate } from "@/lib/eval/judge";
import type { EvalMetrics } from "@/lib/schema";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { normalizeExtractInput } from "./normalize";
import { completeExtractJson, assertGapExtractLlmReady } from "./client";
import { IMPROVER_SYSTEM_PROMPT, GAP_PROMPT_REGISTRY, gapPromptByVersion } from "./prompts";
import { improverPayloadSchema, proposerPayloadSchema } from "./contracts";
import {
  championPromptVersion,
  createExtractRun,
  completeRun,
  failRun,
  listGoldGaps,
  listPromptVersions,
  markRunRunning,
  recentFewShots,
  recordHillclimbError,
  setChampionVersion,
  upsertPromptVersion,
  addRunStep,
} from "./store";
import { packNormalizedSource } from "./normalize";
import type { ActorFunction } from "@/lib/iegp/enums";

function pairGapExtract(
  extracted: { name: string; statement: string }[],
  gold: { id: string; name: string; statement: string; must_find: boolean; is_gap: boolean }[],
) {
  const usedGold = new Set<string>();
  const usedExtract = new Set<number>();
  const rows: { kind: "exact" | "partial" | "wrong" | "new" | "missed"; gold_id?: string; extract_i?: number; sim: number }[] =
    [];
  const ranked: { i: number; g: (typeof gold)[0]; sim: number }[] = [];
  extracted.forEach((e, i) => {
    for (const g of gold) {
      const sim = Math.max(statementSimilarity(e.statement, g.statement), statementSimilarity(e.name, g.name));
      ranked.push({ i, g, sim });
    }
  });
  ranked.sort((a, b) => b.sim - a.sim);
  for (const row of ranked) {
    if (usedExtract.has(row.i) || usedGold.has(row.g.id)) continue;
    if (row.sim >= 0.58) {
      rows.push({ kind: row.g.is_gap ? "exact" : "wrong", gold_id: row.g.id, extract_i: row.i, sim: row.sim });
      usedExtract.add(row.i);
      usedGold.add(row.g.id);
    } else if (row.sim >= 0.32) {
      rows.push({ kind: row.g.is_gap ? "partial" : "wrong", gold_id: row.g.id, extract_i: row.i, sim: row.sim });
      usedExtract.add(row.i);
      usedGold.add(row.g.id);
    }
  }
  extracted.forEach((e, i) => {
    if (usedExtract.has(i)) return;
    rows.push({ kind: "new", extract_i: i, sim: 0 });
  });
  for (const g of gold) {
    if (usedGold.has(g.id)) continue;
    if (g.is_gap && g.must_find) rows.push({ kind: "missed", gold_id: g.id, sim: 0 });
  }
  return rows;
}

function metricsFromPairs(
  pairs: ReturnType<typeof pairGapExtract>,
  gold: { id: string; must_find: boolean; is_gap: boolean }[],
  extractedCount: number,
): EvalMetrics {
  const exact = pairs.filter((p) => p.kind === "exact").length;
  const partial = pairs.filter((p) => p.kind === "partial").length;
  const wrong = pairs.filter((p) => p.kind === "wrong").length;
  const missed = pairs.filter((p) => p.kind === "missed").length;
  const novel = pairs.filter((p) => p.kind === "new").length;
  const must = gold.filter((g) => g.must_find && g.is_gap);
  const mustPaired = must.filter((g) =>
    pairs.some((p) => p.gold_id === g.id && (p.kind === "exact" || p.kind === "partial")),
  ).length;
  const precision = extractedCount === 0 ? 0 : (exact + 0.5 * partial) / extractedCount;
  const recall = must.length === 0 ? 1 : mustPaired / must.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const wrong_rate = extractedCount === 0 ? 0 : wrong / extractedCount;
  const gapGold = gold.filter((g) => g.is_gap).length;
  const missed_rate = gapGold === 0 ? 0 : missed / gapGold;
  const partial_rate = extractedCount === 0 ? 0 : partial / extractedCount;
  const new_rate = extractedCount === 0 ? 0 : novel / extractedCount;
  const composite = round4(
    0.34 * f1 +
      0.22 * (1 - wrong_rate) +
      0.2 * (1 - missed_rate) +
      0.14 * (1 - partial_rate) +
      0.1 * Math.min(new_rate, 0.25),
  );
  return {
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    partial_rate: round4(partial_rate),
    wrong_rate: round4(wrong_rate),
    missed_rate: round4(missed_rate),
    new_rate: round4(new_rate),
    composite,
    matched: exact,
    partial,
    wrong,
    missed,
    novel,
    extracted_count: extractedCount,
    gold_count: gold.length,
  };
}

export async function runGapPromptHillclimb(args: {
  actor_name: string;
  actor_function: ActorFunction;
  trigger: string;
}): Promise<{ run_id: string; champion: string }> {
  assertGapExtractLlmReady();
  const champion = await championPromptVersion();
  const gold = await listGoldGaps();
  const fewShots = await recentFewShots();
  const dbPrompts = await listPromptVersions();
  const prompts =
    dbPrompts.length > 0
      ? dbPrompts.map((p) => ({
          version: p.version,
          title: p.title,
          summary: p.summary,
          system_prompt: p.system_prompt,
        }))
      : GAP_PROMPT_REGISTRY;

  const run = await createExtractRun({
    kind: "hillclimb",
    persist: false,
    format: "markdown",
    prompt_version: champion,
    champion_version: champion,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    title: `Hill-climb (${args.trigger})`,
    input: { trigger: args.trigger, gold_count: gold.length },
  });
  await markRunRunning(run.id);

  try {
    const scored: { version: string; metrics: EvalMetrics }[] = [];
    let championVersion = champion;
    let championMetrics: EvalMetrics | null = null;

    for (const prompt of prompts) {
      const extracted: { name: string; statement: string; source_key: string }[] = [];
      for (const file of DEMO_PACK) {
        const source = normalizeExtractInput({
          format: "markdown",
          markdown: file.text,
          title: file.title,
          filename: file.filename,
        });
        const packed = packNormalizedSource(source);
        const json = await completeExtractJson({
          system: prompt.system_prompt,
          user: `${packed}\n\nHill-climb proposer-only pass. Human few-shots:\n${JSON.stringify(fewShots)}`,
        });
        const parsed = proposerPayloadSchema.parse(json);
        for (const gap of parsed.gaps) {
          extracted.push({ name: gap.name, statement: gap.statement, source_key: file.id });
        }
      }
      const goldFor = gold.map((g) => ({
        id: g.id,
        name: g.name,
        statement: g.statement,
        must_find: g.must_find,
        is_gap: g.is_gap,
      }));
      const pairs = pairGapExtract(extracted, goldFor);
      const metrics = metricsFromPairs(pairs, goldFor, extracted.length);
      const judge = judgeCandidate({
        candidateVersion: prompt.version,
        championVersion,
        candidate: metrics,
        champion: championMetrics,
      });
      if (!championMetrics) {
        championVersion = prompt.version;
        championMetrics = metrics;
      } else if (judge.decision === "promote") {
        championVersion = prompt.version;
        championMetrics = metrics;
      }
      scored.push({ version: prompt.version, metrics });
      await addRunStep({
        run_id: run.id,
        round: 0,
        role: `eval:${prompt.version}`,
        request: { version: prompt.version },
        response: { metrics, judge },
      });
    }

    const improverRaw = await completeExtractJson({
      system: IMPROVER_SYSTEM_PROMPT,
      user: JSON.stringify({
        champion: championVersion,
        scored,
        fewShots,
        trigger: args.trigger,
      }),
    });
    const improver = improverPayloadSchema.parse(improverRaw);
    await addRunStep({
      run_id: run.id,
      round: 0,
      role: "improver",
      request: { trigger: args.trigger },
      response: improver,
    });

    if (improver.system_prompt && improver.recommended_prompt_version) {
      const parent = gapPromptByVersion(championVersion);
      await upsertPromptVersion({
        version: improver.recommended_prompt_version,
        title: improver.recommended_prompt_version,
        summary: improver.rationale.join(" "),
        system_prompt: improver.system_prompt,
        parent_version: championVersion,
        prompt_patch: improver.prompt_patch,
        origin: "improver",
      });
      void parent;
    } else if (improver.prompt_patch && improver.recommended_prompt_version) {
      const parent = gapPromptByVersion(championVersion);
      await upsertPromptVersion({
        version: improver.recommended_prompt_version,
        title: improver.recommended_prompt_version,
        summary: improver.rationale.join(" "),
        system_prompt: `${parent.system_prompt}\n\n## Patch\n${improver.prompt_patch}`,
        parent_version: championVersion,
        prompt_patch: improver.prompt_patch,
        origin: "improver",
      });
    }

    await setChampionVersion(championVersion, scored.find((s) => s.version === championVersion)?.metrics);
    await completeRun({
      id: run.id,
      result: { champion: championVersion, scored, improver },
      metrics: scored.find((s) => s.version === championVersion)?.metrics,
      prompt_version: championVersion,
    });
    return { run_id: run.id, champion: championVersion };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hill-climb failed";
    await failRun(run.id, message);
    await recordHillclimbError(message);
    throw error;
  }
}
