/** Bounded durable progression: replay real stages, dispatch one claimed raw request, checkpoint and return. */
import { progressEvaluation } from './evaluation-worker';
import { findProvider, providerServes } from '@/modules/llm/provider';
import { providerApiKey } from '@/modules/llm/api-keys';
import { redactSecrets } from '@/modules/llm/provider-error';
import { completionFor } from '@/modules/kernel/routing';
import { tracedCompletion, redactPromptSecrets } from '@/modules/kernel/llm-calls';
import type { JsonCompletion, RunHandle } from '@/modules/kernel/contracts';
import { canonicalParsedJson, sha256 } from './documents';
import { executionCodeIdentity, requireSectionAi } from './execution';
import { SECTION_DEPENDENCIES } from './execution-schema';
import { executeDevelopmentSection, type DevelopmentSectionResult } from './stage-execution';
import { DevelopmentError, type DevelopmentSection } from './schema';
import { beginCall, checkpointCall, claimExecution, getExecution, publishSection, releaseExecution, requireClaim, settleCall, startSection, type CallReceipt, type Execution, type ExecutionCall, type SectionAttempt } from './execution-store';
class NextCall extends Error { constructor(readonly call: ExecutionCall) { super('Durable next call checkpointed.'); } }
/** A private trace recorder keeps adapter IDs stable and never opens customer runs. */
function recorder(id: string): RunHandle { return { id, step: async (_name, fn) => fn(), note: () => {}, steps: () => [] }; }
/** Persist actionable codes privately while stripping configured credentials from provider errors. */
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Execution could not continue.';
  return redactPromptSecrets(redactSecrets(message, ['xai-grok', 'anthropic-claude', 'openai', 'google-gemini', 'openrouter'].map(id => providerApiKey(id)).filter((key): key is string => Boolean(key)))).slice(0, 1200);
}
function prerequisitesFor(execution: Execution, section: DevelopmentSection): { results: Partial<Record<DevelopmentSection, DevelopmentSectionResult>>; ids: SectionAttempt['prerequisites']; valid: boolean } {
  const results: Partial<Record<DevelopmentSection, DevelopmentSectionResult>> = {}, ids: SectionAttempt['prerequisites'] = {};
  for (const dependency of SECTION_DEPENDENCIES[section]) {
    const own = execution.sections.find(attempt => attempt.section === dependency);
    const frozen = execution.manifest.prerequisites[dependency];
    const result = own ? own.status === 'succeeded' ? own.result : null : frozen?.result;
    if (!result || result.generation_status !== 'succeeded') return { results, ids, valid: false };
    results[dependency] = result; ids[dependency] = own?.id ?? frozen!.attempt_id;
  }
  return { results, ids, valid: true };
}
/** Re-enter the actual stage: saved identical raw replies are returned and the first unseen call yields. */
async function compute(execution: Execution, token: string, section: SectionAttempt, prerequisites: Partial<Record<DevelopmentSection, DevelopmentSectionResult>>): Promise<DevelopmentSectionResult> {
  let ordinal = 0;
  const run = recorder(section.id);
  const complete: JsonCompletion = async request => {
    if (!request.role) throw new DevelopmentError(409, 'missing_role', 'The stage must identify its completion role explicitly.');
    const frozen = execution.manifest.routes[section.section]?.[request.role];
    if (!frozen) throw new DevelopmentError(409, 'route_mismatch', 'This role was not included in the frozen execution configuration.');
    return completionFor(frozen.actual, run, { completeRaw: async raw => {
      const index = ordinal++;
      const identity = sha256(canonicalParsedJson({ section_id: section.id, ordinal: index, code: execution.manifest.code_identity, request: raw, route: frozen }));
      const call = await checkpointCall(execution, token, section, index, identity, raw, frozen);
      if (call.status === 'succeeded' && call.receipt) return call.receipt.text;
      if (call.status === 'queued') throw new NextCall(call);
      throw new DevelopmentError(409, 'uncertain_call', 'A dispatched call has no replayable receipt. Inspect this execution before starting a fresh attempt.');
    } })(request);
  };
  const result = await executeDevelopmentSection({ section: section.section, sources: execution.manifest.sources, prerequisites, mode: execution.manifest.config.mode, recorder: run, complete, route: execution.manifest.routes[section.section].proposer!.actual, module_identity: execution.manifest.modules[section.section], prompt_identity: execution.manifest.prompts[section.section] });
  if (ordinal !== execution.calls.filter(call => call.section_id === section.id).length) throw new DevelopmentError(409, 'replay_mismatch', 'The resumed computation consumed a different number of saved replies.');
  return result;
}
/** Refuse credential-bearing replies rather than altering replay input or persisting a secret. */
export function assertSafeReceiptText(text: string, secrets: string[]): void {
  if (redactPromptSecrets(redactSecrets(text, secrets)) !== text) throw new DevelopmentError(422, 'unsafe_response', 'Provider response contained a credential and was discarded.');
}
/** Perform one network call only after the database has committed its sending marker. */
async function dispatch(execution: Execution, token: string, section: SectionAttempt, call: ExecutionCall): Promise<void> {
  const route = call.route.actual;
  const provider = findProvider(route.provider_id);
  const api_key = providerApiKey(route.provider_id);
  if (!provider || !providerServes(provider, route.model) || !api_key) throw new DevelopmentError(409, 'route_unavailable', 'The frozen provider/model credentials are no longer available. Start a fresh execution after correcting them.');
  await requireSectionAi(section.section);
  await requireClaim(execution.id, token);
  if (!await beginCall(execution.id, token, call.id)) throw new DevelopmentError(409, 'dispatch_conflict', 'This call was already claimed; it cannot be resent.');
  let receipt: CallReceipt;
  let failure: ExecutionCall['failure_accounting'] = null;
  try {
    receipt = await tracedCompletion({ provider, request: call.request.request, api_key, run: recorder(section.id), step: `llm:${call.request.purpose}`, detail: `${provider.label} · ${route.model}`, purpose: call.request.purpose, attempt: call.request.attempt, stage: route.stage, workspace_id: null, maxAttempts: 1,
      beforeSend: async () => { await requireClaim(execution.id, token); await requireSectionAi(section.section); },
      onFailure: accounting => { failure = accounting; },
    });
    failure = { usage: receipt.usage, cost_usd: receipt.cost_usd, price_source: receipt.price_source };
    assertSafeReceiptText(receipt.text, ['xai-grok', 'anthropic-claude', 'openai', 'google-gemini', 'openrouter'].map(providerApiKey).filter((key): key is string => Boolean(key)));
  } catch (error) {
    // Even an explicit provider failure is terminal. The call can never return to queued.
    await settleCall(execution.id, token, call.id, null, safeError(error), failure);
    throw error;
  }
  // Deliberately outside the provider catch: a receipt-write failure leaves sending indeterminate.
  await settleCall(execution.id, token, call.id, receipt);
}
export type WorkerProgress = { processed: boolean; execution_id?: string; generation_status?: Execution['generation_status']; evaluation_id?: string; evaluation_status?: import('./evaluation-store').EvaluationStatus };
/** Advance one execution with at most one actual provider send; repeated scheduler delivery is safe. */
export async function progressExecution(id?: string): Promise<WorkerProgress> {
  const claimed = await claimExecution(id);
  if (!claimed) return id ? { processed: false } : progressEvaluation();
  let execution = claimed.execution;
  const token = claimed.token;
  if (execution.calls.some(call => call.status === 'sending')) {
    await releaseExecution(execution.id, token, 'needs_attention', 'Interrupted after dispatch: provider acceptance or receipt is uncertain. No automatic resend.');
    return { processed: true, execution_id: execution.id, generation_status: 'needs_attention' };
  }
  try {
    if (execution.manifest.code_identity !== executionCodeIdentity()) throw new DevelopmentError(409, 'code_changed', 'The deployed code changed. Start a new execution; saved calls cannot resume under different code.');
    for (const initial of execution.sections) {
      const section = execution.sections.find(attempt => attempt.id === initial.id)!;
      if (!['queued', 'running'].includes(section.status)) continue;
      await startSection(execution.id, token, section.id);
      const dependency = prerequisitesFor(execution, section.section);
      if (!dependency.valid) {
        await publishSection(execution.id, token, section.id, 'blocked', null, 'A required current prerequisite failed or was rejected.', dependency.ids);
      } else {
        try {
          const result = await compute(execution, token, section, dependency.results);
          // Refuse skipped or divergent completion paths, even if they happen to return output.
          const saved = execution.calls.filter(call => call.section_id === section.id);
          if (saved.some(call => call.status !== 'succeeded')) throw new DevelopmentError(409, 'replay_mismatch', 'Computation completed with unsettled saved calls.');
          await publishSection(execution.id, token, section.id, result.generation_status, result, result.reason, dependency.ids);
        } catch (error) {
          if (error instanceof NextCall) {
            try { await dispatch(execution, token, section, error.call); }
            catch (dispatchError) {
              const current = await getExecution(execution.experiment_id, execution.id);
              if (current.calls.some(call => call.status === 'sending')) {
                await releaseExecution(execution.id, token, 'needs_attention', safeError(dispatchError));
                return { processed: true, execution_id: execution.id, generation_status: 'needs_attention' };
              }
              await publishSection(execution.id, token, section.id, 'failed', null, safeError(dispatchError), dependency.ids);
            }
            await releaseExecution(execution.id, token, 'queued');
            return { processed: true, execution_id: execution.id, generation_status: 'queued' };
          }
          await publishSection(execution.id, token, section.id, 'failed', null, safeError(error), dependency.ids);
        }
      }
      execution = await getExecution(execution.experiment_id, execution.id);
    }
    const status = execution.sections.some(section => ['failed', 'blocked', 'rejected'].includes(section.status)) ? 'failed' : 'succeeded';
    await releaseExecution(execution.id, token, status);
    return { processed: true, execution_id: execution.id, generation_status: status };
  } catch (error) {
    await releaseExecution(execution.id, token, 'failed', safeError(error));
    return { processed: true, execution_id: execution.id, generation_status: 'failed' };
  }
}
