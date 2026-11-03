/** Bounded durable evaluator dispatch; raw receipt settlement precedes parsing and publication. */
import { CostPause, CostSettlementPending, reserveCost, settleCost } from './cost-store';
import { rawCallBound, developmentUsageCost } from './cost';
import { PROVIDERS, findProvider, providerServes } from '@/modules/llm/provider';
import { providerApiKey } from '@/modules/llm/api-keys';
import { redactSecrets } from '@/modules/llm/provider-error';
import { tracedCompletion } from '@/modules/kernel/llm-calls';
import { executionCodeIdentity, requireSectionAi, deliveryConfiguration } from './execution';
import { DevelopmentError } from './schema';
import { beginEvaluationSend, claimEvaluation, getEvaluation, releaseEvaluation, requireEvaluationClaim, settleEvaluationReceipt, type Evaluation, type EvaluationStatus } from './evaluation-store';
import type { CallReceipt, ExecutionCall } from './execution-store';
import { scoreEvaluation } from './evaluation-scoring';
function safeError(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : 'Evaluation could not continue.', PROVIDERS.map(provider => providerApiKey(provider.id)).filter((key): key is string => Boolean(key))).slice(0, 1200); }
/** Repair the ledger from the saved outcome without authorizing another evaluator send. */
async function settleSavedEvaluationCost(evaluation: Evaluation): Promise<void> {
  const route = evaluation.manifest.route?.actual;
  if (!route) return;
  const usage = evaluation.receipt?.usage ?? evaluation.failure_accounting?.usage ?? null;
  try {
    await settleCost(evaluation.manifest.execution_id, evaluation.id, developmentUsageCost(route.provider_id, route.model, usage), Boolean(evaluation.receipt));
  } catch (error) {
    throw new CostSettlementPending(error);
  }
}
export type EvaluationProgress = { processed: boolean; evaluation_id?: string; evaluation_status?: EvaluationStatus };
/** Claim and advance one evaluation with at most one provider send and no automatic uncertain retry. */
export async function progressEvaluation(id?: string): Promise<EvaluationProgress> {
  const claim = await claimEvaluation(id);
  if (!claim) return { processed: false };
  const { evaluation, token } = claim, manifest = evaluation.manifest;
  const done = async (status: 'succeeded' | 'failed' | 'needs_attention', error: string | null = null, result: Evaluation['result'] = null): Promise<EvaluationProgress> => {
    await releaseEvaluation(evaluation.id, token, status, result, error);
    return { processed: true, evaluation_id: evaluation.id, evaluation_status: status };
  };
  if (evaluation.status === 'sending') return done('needs_attention', 'Interrupted after dispatch: provider acceptance or receipt is uncertain. No automatic resend.');
  try {
    if (manifest.code_identity !== executionCodeIdentity()) throw new DevelopmentError(409, 'code_changed', 'Evaluator code changed. Start a fresh evaluation; saved calls cannot resume under different code.');
    if (evaluation.status === 'received') {
      await settleSavedEvaluationCost(evaluation);
      if (!evaluation.receipt) throw new Error(evaluation.error ?? 'Provider request failed without a replayable receipt.');
      return await done('succeeded', null, scoreEvaluation(manifest, JSON.parse(evaluation.receipt.text)));
    }
    if (!manifest.request || !manifest.route) return await done('succeeded', null, scoreEvaluation(manifest));
    if (!deliveryConfiguration().available) throw new DevelopmentError(503, 'delivery_unavailable', 'Durable evaluation delivery is unavailable.');
    const route = manifest.route.actual, provider = findProvider(route.provider_id), api_key = providerApiKey(route.provider_id);
    if (!provider || !providerServes(provider, route.model) || !api_key) throw new DevelopmentError(409, 'route_unavailable', 'The frozen evaluator provider/model credentials are unavailable.');
    await requireSectionAi(manifest.section); await requireEvaluationClaim(evaluation.id, token);
    await reserveCost(manifest.execution_id, evaluation.id, 'evaluation', rawCallBound(route.provider_id, manifest.request));
    await beginEvaluationSend(evaluation.id, token);
    let receipt: CallReceipt;
    let failure: ExecutionCall['failure_accounting'] = null;
    try {
      receipt = await tracedCompletion({ provider, request: manifest.request, api_key,
        run: { id: evaluation.id, step: async (_name, fn) => fn(), note: () => {} },
        step: 'llm:development-evaluation', detail: `${provider.label} · ${route.model}`, purpose: `development-evaluation:${manifest.section}`, attempt: 1, stage: route.stage, workspace_id: null, maxAttempts: 1,
        beforeSend: async () => { await requireEvaluationClaim(evaluation.id, token); await requireSectionAi(manifest.section); }, onFailure: accounting => { failure = accounting; },
      });
    } catch (error) {
      await settleEvaluationReceipt(evaluation.id, token, null, safeError(error), failure);
      await settleSavedEvaluationCost({ ...evaluation, receipt: null, failure_accounting: failure });
      return await done('failed', safeError(error));
    }
    // This write is deliberately outside the provider catch: indeterminate settlement is never resent.
    await settleEvaluationReceipt(evaluation.id, token, receipt);
    await settleSavedEvaluationCost({ ...evaluation, receipt });
    await releaseEvaluation(evaluation.id, token, 'received', null);
    return { processed: true, evaluation_id: evaluation.id, evaluation_status: 'received' };
  } catch (error) {
    if (error instanceof CostPause) {
      await releaseEvaluation(evaluation.id, token, 'queued', null, error.message);
      return { processed: true, evaluation_id: evaluation.id, evaluation_status: 'queued' };
    }
    const current = await getEvaluation(evaluation.experiment_id, evaluation.id);
    if (error instanceof CostSettlementPending && current.status === 'received') {
      // Preserve the saved provider error as well as its receipt/failure accounting.
      await releaseEvaluation(evaluation.id, token, 'received', null, current.error);
      return { processed: true, evaluation_id: evaluation.id, evaluation_status: 'received' };
    }
    return done(current.status === 'sending' ? 'needs_attention' : 'failed', safeError(error));
  }
}
