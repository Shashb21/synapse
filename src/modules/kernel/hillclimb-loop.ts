import type { Actor, EvalCase, EvalScore, StageId, SynapseModule } from "./contracts";
import type { Role } from "@/modules/auth/roles";
import { approvedEvaluationRoute } from "./approved-evaluation-route";
import { compositeScore, recordPromptBaseline } from "./baselines";
import {
  aggregateCaseMetrics,
  assertDiagnosticWorkspace,
  evalWorkspace,
  recordEvalRun,
  validScores,
  type EvalExecution,
} from "./evals";
import { withEvaluationIsolation } from "./evaluation-isolation";
import { evidenceHash } from "./decision-replay";
import { newId } from "./ids";
import { isTestStub } from "./llm";
import { activeRevisionPointer, getPromptRevision } from "./prompt-revisions";
import { PROMPT_VARIANT_STAGES, promptVersionsFor, type PromptVersionId } from "./prompt-versions";
import { activeModule } from "./registry";
import { getWorkspace } from "@/modules/workspaces/store";
import { withPromptRevision, withPromptVariant } from "./prompt-variant";
import { runStage } from "./run";
import { DiagnosticPreview, diagnosticRequestBudget, type RequestIdentity } from "./diagnostic-requests";
import { TrustedApplicationError } from "./stage-errors";
import { sectionOfStage } from "./ai-sections";
import { aiEnabled, aiSectionEnabled } from "./ai-switch";

type VariantObservation = {
  prompt_version: PromptVersionId;
  metrics: EvalScore[];
  cases: number;
  composite: number | null;
  historical_drift: number | null;
  passed: boolean | null;
  eval_run_id: string;
  prompt_hash: string | null;
  first_prompt_hash: string | null;
};
function targetMetric(stage: StageId, test: EvalCase<unknown>) {
  if (
    (stage === "S2" || stage === "S3") &&
    test.gold?.must_match?.length &&
    test.gold.must_match.every((needle) => needle.trim())
  )
    return "curated_must_match";
  // S1 fixture lookup is filename-based. Its checks have no verified content identity.
  return null;
}

/** The owner run list offers only active implementations with genuinely distinct, scorable variants. */
export async function availableDiagnosticSweeps(workspace_id: string): Promise<StageId[]> {
  if (isTestStub() || (await getWorkspace(workspace_id))?.demo_mode) return [];
  return withEvaluationIsolation(async () => {
    const stages = await Promise.all(
      PROMPT_VARIANT_STAGES.map(async (stage) => {
        const section = sectionOfStage(stage);
        if (section && !(await aiSectionEnabled(section))) return [];
        const implementation = await activeModule(stage);
        const harness = implementation.evals;
        if (
          !harness?.variantInstruction ||
          !implementation.freeze ||
          new Set(promptVersionsFor(stage).map((v) => harness.variantInstruction!(v).trim())).size !==
            promptVersionsFor(stage).length
        )
          return [];
        if (!(await harness.cases()).some((test) => targetMetric(stage, test))) return [];
        try {
          await approvedEvaluationRoute(stage);
          return [stage];
        } catch {
          return [];
        }
      }),
    );
    return stages.flat();
  });
}

export function sweepChampion(variants: VariantObservation[]) {
  if (
    variants.length < 2 ||
    variants.some((v) => v.composite === null || !v.first_prompt_hash) ||
    new Set(variants.map((v) => v.first_prompt_hash)).size !== variants.length
  )
    return null;
  const ranked = [...variants].sort((a, b) => b.composite! - a.composite!);
  return ranked[0].composite === ranked[1].composite ? null : ranked[0].prompt_version;
}

/** Server-owned diagnostic cases. Only curated targets support a scored result. */
export async function runOwnerDiagnostics(
  module: SynapseModule<unknown, unknown>,
  identity: { actor: Actor; role: Role },
  requestedWorkspace: unknown,
  sweep: boolean,
) {
  return withEvaluationIsolation(async () => {
    const workspace_id = await evalWorkspace();
    if (requestedWorkspace !== undefined && requestedWorkspace !== workspace_id)
      throw new TrustedApplicationError("Select the same workspace as the diagnostic request.");
    await assertDiagnosticWorkspace(workspace_id);
    const { stage, id: module_id, version: module_version } = module.manifest;
    const harness = module.evals;
    if (!harness) throw new TrustedApplicationError("The selected module has no diagnostic cases.");
    const group_id = newId("harness");
    const common = { workspace_id, stage, module_id, module_version, group_id };
    const variants: VariantObservation[] = [];
    const result = (reason: string | null = null) => ({
      stage,
      module_id,
      module_version,
      group_id,
      variants,
      champion: sweep && !reason ? sweepChampion(variants) : null,
      reason,
    });
    const versions = sweep ? promptVersionsFor(stage) : ["v1.0-baseline" as const];
    const instructions = new Set<string>();
    const distinct = versions.filter((v) => {
      const instruction = harness.variantInstruction?.(v).trim() ?? "";
      if (instructions.has(instruction)) return false;
      instructions.add(instruction);
      return true;
    });
    if (sweep && (distinct.length < 2 || distinct.length !== versions.length))
      return result("Each registered variant must have a distinct prompt instruction.");
    if (sweep && isTestStub()) return result("Synthetic runs cannot compare model prompts.");
    let cases = await harness.cases();
    if (sweep) cases = cases.filter((c) => targetMetric(stage, c));
    if (!cases.length)
      return result(sweep ? "No curated targets are available to compare." : "No diagnostic cases are available.");
    if (sweep && !module.freeze) return result("The module cannot freeze the comparison inputs.");
    const prepared = await Promise.all(
      cases.map(async (test) => {
        if (!test.input || typeof test.input !== "object" || ("apply" in test.input && test.input.apply))
          throw new TrustedApplicationError("The diagnostic case requests an unsupported operation.");
        const input = { ...test.input, dry_run: true, persist: false };
        const parsed = module.inputSchema.parse(input);
        return { test, input, facts: await module.freeze?.(parsed) };
      }),
    );
    const case_hash = evidenceHash(prepared);
    const section = sectionOfStage(stage);
    const ai = section ? await aiSectionEnabled(section) : await aiEnabled();
    const usesModel = module.manifest.agentic || module.manifest.needs_ai || module.manifest.ai_optional;
    const route = ai && usesModel && !isTestStub() ? await approvedEvaluationRoute(stage) : null;
    const pointer = await activeRevisionPointer(workspace_id, stage);
    const revision = pointer.revision_id ? await getPromptRevision(pointer.revision_id, workspace_id) : null;
    if (pointer.revision_id && !revision)
      throw new TrustedApplicationError("The active prompt revision is unavailable.");
    const selected = { id: revision?.id ?? null, instruction: revision?.instruction_text ?? "" };

    const budget = diagnosticRequestBudget();
    const previews = new Map<PromptVersionId, RequestIdentity[]>();
    function execute(variant: PromptVersionId, index: number, preview: boolean) {
      const { input, facts } = prepared[index];
      return withPromptRevision(selected, () =>
        withPromptVariant(variant, () =>
          runStage({
            stage,
            actor: identity.actor,
            role: identity.role,
            workspace_id,
            input,
            diagnostic: {
              group_id,
              module_id,
              module_version,
              route,
              facts: facts && structuredClone(facts),
              preview,
              approved_first: previews.get(variant)?.[index],
              budget,
            },
          }),
        ),
      );
    }
    if (sweep) {
      const seen = prepared.map(() => new Set<string>());
      for (const variant of distinct) {
        const approved: RequestIdentity[] = [];
        for (const index of prepared.keys()) {
          try {
            await execute(variant, index, true);
            return result("A curated case produced no model request during preview.");
          } catch (error) {
            if (!(error instanceof DiagnosticPreview)) throw error;
            if (seen[index].has(error.identity.wire))
              return result("Two variants produce the same request for a curated case.");
            seen[index].add(error.identity.wire);
            approved.push(error.identity);
          }
        }
        previews.set(variant, approved);
      }
    }
    for (const variant of distinct) {
      const observations: EvalScore[][] = [];
      const prompts: (string | null)[] = [];
      const firstPrompts: (string | null)[] = [];
      const routes = new Set<string | null>();
      const executions = new Set<EvalExecution>();
      for (const [index, { test }] of prepared.entries()) {
        const run = await execute(variant, index, false);
        const actual = run.diagnostic!;
        const raw = harness.score({ case: test, output: run.output });
        const target =
          actual.execution === "routed" && actual.prompt_hash && validScores(raw) ? targetMetric(stage, test) : null;
        const metrics = raw
          .filter((s) => Number.isFinite(s.value))
          .map((s) => ({ ...s, target: s.name === target ? s.target : undefined }));
        observations.push(metrics);
        routes.add(actual.route_hash);
        prompts.push(actual.prompt_hash);
        firstPrompts.push(actual.first_prompt_hash);
        executions.add(actual.execution);
        await recordEvalRun({
          ...common,
          kind: sweep ? "sweep_case" : "harness_case",
          run_id: run.run_id,
          metrics,
          lineage: { ...actual, case_hash, variant, case_name: test.name },
        });
      }
      const execution = executions.size === 1 ? [...executions][0] : "mixed";
      const route_hash = routes.size === 1 ? [...routes][0] : null;
      const prompt_hash = prompts.every(Boolean) ? evidenceHash(prompts) : null;
      const comparable = execution === "routed" && !!route_hash && !!prompt_hash;
      const aggregate = aggregateCaseMetrics(observations);
      const metrics = comparable ? aggregate : aggregate.map((s) => ({ ...s, target: undefined }));
      const row = await recordEvalRun({
        ...common,
        kind: sweep ? "sweep_summary" : "harness_summary",
        metrics,
        lineage: { execution, route_hash, prompt_hash, case_hash, variant },
        note: `${cases.length} diagnostic case(s)`,
      });
      const composite = compositeScore(metrics);
      const historical_drift =
        sweep && comparable && composite !== null
          ? await recordPromptBaseline(
              {
                workspace_id,
                stage,
                module_id,
                module_version,
                route_hash,
                case_hash,
                prompt_hash: evidenceHash({ effective: prompt_hash, revision: selected }),
              },
              variant,
              metrics,
              group_id,
            )
          : null;
      variants.push({
        prompt_version: variant,
        metrics,
        composite,
        historical_drift,
        cases: cases.length,
        passed: row.passed,
        eval_run_id: row.id,
        prompt_hash,
        first_prompt_hash: firstPrompts.every(Boolean) ? evidenceHash(firstPrompts) : null,
      });
    }
    return result();
  });
}
