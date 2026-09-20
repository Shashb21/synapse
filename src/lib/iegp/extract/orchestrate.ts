import type { ActorFunction, SourceType } from "@/lib/iegp/enums";
import { SOURCE_TYPES } from "@/lib/iegp/enums";
import { assertGapExtractLlmReady } from "./client";
import { normalizeExtractInput } from "./normalize";
import { runGapExtractionLoop } from "./loop";
import {
  addRunStep,
  championPromptVersion,
  completeRun,
  createExtractRun,
  failRun,
  getExtractRun,
  listGoldGaps,
  loadPromptVersion,
  markRunRunning,
  persistLoopTrace,
  recentFewShots,
} from "./store";
import type { ExtractRunRow } from "./store";
import type { NormalizedSource } from "./contracts";

export type GapExtractRequest = {
  format?: "markdown" | "json";
  markdown?: string;
  json?: unknown;
  title?: string;
  filename?: string;
  source_type?: SourceType;
  stakeholder_function?: ActorFunction;
  persist?: boolean;
  wait?: boolean;
  score_vs_gold?: boolean;
  source_key?: string;
  actor_name: string;
  actor_function: ActorFunction;
  prompt_version?: string;
};

function asSourceType(value: string | undefined): SourceType {
  if (value && (SOURCE_TYPES as readonly string[]).includes(value)) return value as SourceType;
  return "other_internal";
}

async function executeExtractRun(run: ExtractRunRow, source: NormalizedSource, req: GapExtractRequest) {
  await markRunRunning(run.id);
  try {
    const prompt = await loadPromptVersion(run.prompt_version);
    const fewShots = await recentFewShots();
    const gold = req.score_vs_gold ? await listGoldGaps() : [];
    const sourceKey = req.source_key || source.filename.replace(/\.[^.]+$/, "");
    const result = await runGapExtractionLoop({
      source,
      prompt,
      fewShots,
      includeGold: Boolean(req.score_vs_gold),
      goldForSource: gold
        .filter((g) => g.source_key === sourceKey || g.source_key === req.title)
        .map((g) => ({ id: g.id, name: g.name, statement: g.statement, is_gap: g.is_gap })),
    });
    await persistLoopTrace(run.id, result);

    let persistInfo: { sourceId: string; createdGapIds: string[]; mergedGapIds: string[] } | null =
      null;
    if (req.persist) {
      const { ingestJudgedExtraction } = await import("@/lib/iegp/store");
      persistInfo = await ingestJudgedExtraction({
        title: source.title,
        filename: source.filename,
        source_type: asSourceType(req.source_type),
        stakeholder_function: req.stakeholder_function ?? req.actor_function,
        text: source.full_text,
        blocks: source.blocks,
        gaps: result.gaps,
        needs: result.needs,
        actor_name: req.actor_name,
        actor_function: req.actor_function,
        extract_run_id: run.id,
        prompt_version: result.prompt_version,
        source_key: req.source_key,
      });
    }

    const payload = {
      ...result,
      persist: persistInfo,
      observed_in: persistInfo
        ? { created: persistInfo.createdGapIds, joined_existing: persistInfo.mergedGapIds }
        : null,
    };
    await completeRun({
      id: run.id,
      result: payload,
      source_id: persistInfo?.sourceId ?? null,
      prompt_version: result.prompt_version,
    });
    return getExtractRun(run.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gap extraction failed";
    await addRunStep({
      run_id: run.id,
      round: 0,
      role: "error",
      request: {},
      error: message,
    });
    await failRun(run.id, message);
    throw error;
  }
}

export async function startGapExtraction(req: GapExtractRequest) {
  assertGapExtractLlmReady();
  const source = normalizeExtractInput({
    format: req.format,
    markdown: req.markdown,
    json: req.json,
    title: req.title,
    filename: req.filename,
  });
  const champion = await championPromptVersion();
  const promptVersion = req.prompt_version || champion;
  const run = await createExtractRun({
    kind: "extract",
    persist: Boolean(req.persist),
    format: source.format,
    prompt_version: promptVersion,
    champion_version: champion,
    actor_name: req.actor_name,
    actor_function: req.actor_function,
    title: source.title,
    input: {
      format: source.format,
      title: source.title,
      filename: source.filename,
      persist: Boolean(req.persist),
      block_count: source.blocks.length,
      score_vs_gold: Boolean(req.score_vs_gold),
    },
  });
  if (!req.wait) {
    void executeExtractRun(run, source, req).catch(() => undefined);
    return { run_id: run.id, status: "queued" as const, run };
  }
  const finished = await executeExtractRun(run, source, { ...req, wait: true });
  return { run_id: run.id, status: finished?.run.status ?? "completed", run: finished?.run, steps: finished?.steps };
}

export { getExtractRun };
