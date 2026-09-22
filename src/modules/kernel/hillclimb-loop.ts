import type { EvalScore, StageId, SynapseModule } from "./contracts";
import { runStageEvals } from "./evals";
import { recordPromptBaseline, baselineFor, compositeScore, type PromptBaseline } from "./baselines";
import { promptVersionsFor, type PromptVersionId } from "./prompt-versions";
import { withPromptVariant } from "./prompt-variant";
import { recordSignal } from "./hillclimb";

export type VariantScore = {
  prompt_version: PromptVersionId;
  metrics: EvalScore[];
  composite: number;
  cases: number;
  baseline: PromptBaseline | null;
  delta_vs_baseline: number | null;
  promoted: boolean;
};

export type HillclimbSweepResult = {
  stage: StageId;
  module_id: string;
  module_version: string;
  champion: PromptVersionId;
  variants: VariantScore[];
};

/**
 * Scores each registered prompt variant against curated gold, compares to stored
 * per-prompt-version baselines, and files hillclimb signals when a variant wins.
 */
export async function runHillclimbSweep<I, O>(
  stage: StageId,
  module: SynapseModule<I, O>,
  execute: (input: I) => Promise<O>,
): Promise<HillclimbSweepResult> {
  const versions = promptVersionsFor(stage);
  const variants: VariantScore[] = [];

  for (const version of versions) {
    const { metrics, cases } = await withPromptVariant(version, () => runStageEvals(module, execute));
    const composite = compositeScore(metrics);
    const baseline = await baselineFor(stage, version);
    const delta = baseline ? Number((composite - baseline.composite).toFixed(4)) : null;
    variants.push({
      prompt_version: version,
      metrics,
      composite,
      cases,
      baseline,
      delta_vs_baseline: delta,
      promoted: false,
    });
    if (cases > 0) {
      await recordPromptBaseline({
        stage,
        prompt_version: version,
        module_id: module.manifest.id,
        module_version: module.manifest.version,
        metrics,
        note: `${cases} curated gold case(s)`,
      });
    }
  }

  const scored = variants.filter((variant) => variant.cases > 0);
  const champion =
    scored.sort((a, b) => b.composite - a.composite)[0]?.prompt_version ?? "v1.0-baseline";

  for (const variant of variants) {
    variant.promoted = variant.prompt_version === champion && variant.cases > 0;
    if (variant.promoted && variant.delta_vs_baseline !== null && variant.delta_vs_baseline > 0.02) {
      await recordSignal({
        stage,
        kind: "hillclimb_promotion",
        subject: `prompt:${variant.prompt_version}`,
        rationale: `Hillclimb sweep promoted ${variant.prompt_version} (composite ${variant.composite}, Δ ${variant.delta_vs_baseline} vs baseline).`,
        weight: 2,
        payload: { metrics: variant.metrics, champion },
      });
    }
  }

  return {
    stage,
    module_id: module.manifest.id,
    module_version: module.manifest.version,
    champion,
    variants,
  };
}
