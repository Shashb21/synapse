/** Validate owner execution requests and freeze source-only generation lineage before publication. */
import { z } from 'zod';
import { assertAiEnabled, AiDisabledError } from '@/modules/kernel/ai-switch';
import { sectionOfStage } from '@/modules/kernel/ai-sections';
import { NoRouteError } from '@/modules/llm/provider';
import { canonicalParsedJson, sha256 } from './documents';
import { listAttemptEvaluations } from './evaluation-store';
import { executionConfigSchema, SECTION_DEPENDENCIES, SECTION_STAGES } from './execution-schema';
import { sectionSchema, DevelopmentError, type DevelopmentSection, type DevelopmentDocument } from './schema';
import { getExperiment, requireRevision } from './store';
import { developmentModuleIdentity } from './stage-execution';
import { freezeRoutes } from './routes';
import { reserveExecution, sectionHistory, listEvaluationAssociations, evaluationFreshness, type EvaluationAssociation, type Execution, type ExecutionManifest, type ReferenceIdentity, type SectionAttempt } from './execution-store';
export const SECTIONS = sectionSchema.options;
export const startExecutionSchema = z.object({
  revision: z.number().int().positive(),
  target: z.union([z.literal('all'), sectionSchema]),
  config: executionConfigSchema.default(() => executionConfigSchema.parse({})),
  prerequisites: z.partialRecord(sectionSchema, z.object({ attempt_id: z.string().min(1).max(200), output_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).default({}),
}).strict();
export type StartExecutionInput = z.infer<typeof startExecutionSchema>;
/** A deployment identity prevents resuming under changed code even when module versions were not bumped. */
export function executionCodeIdentity(): string {
  return process.env.SYNAPSE_DEVELOPMENT_CODE_ID?.trim() || process.env.VERCEL_GIT_COMMIT_SHA?.trim() || (process.env.NODE_ENV === 'test' ? 'isolated-test-code' : '');
}
/** Fail closed until an operator has configured durable authenticated browser-independent delivery. */
export function deliveryConfiguration(): { available: boolean; transport: 'github_actions'; reason: string | null } {
  const timeout = Number(process.env.SYNAPSE_LLM_TIMEOUT_MS ?? 120000);
  const available = Number.isFinite(timeout) && timeout > 0 && timeout <= 120000 && process.env.SYNAPSE_DEVELOPMENT_DELIVERY === 'github_actions' && (process.env.CRON_SECRET?.trim().length ?? 0) >= 24 && Boolean(executionCodeIdentity());
  return { available, transport: 'github_actions', reason: available ? null : 'Configure the GitHub Actions Development worker, its matching secret and deployment code identity before running executions.' };
}
/** Apply both the master switch and this stage's effective section switch. */
export async function requireSectionAi(section: DevelopmentSection): Promise<void> {
  try { await assertAiEnabled('Development generation', sectionOfStage(SECTION_STAGES[section])!); }
  catch (error) {
    if (error instanceof AiDisabledError) throw new DevelopmentError(409, 'ai_disabled', 'AI is turned off for this section or platform. Enable it in AI & routing before running.');
    throw error;
  }
}
const hash = (value: unknown) => sha256(canonicalParsedJson(value));
/** Compare only generation inputs for an upstream section; evaluator-only changes remain independent. */
export function generationIdentity(manifest: ExecutionManifest, section: DevelopmentSection): string {
  return hash({ sources: manifest.sources, mode: manifest.config.mode, stage: manifest.config.stages[section], module: manifest.modules[section], prompt: manifest.prompts[section], code: manifest.code_identity });
}
export type SectionFreshness = { current: boolean; reasons: ('newer_attempt' | 'generation_inputs_changed' | 'prerequisite_changed')[] };
/** Compare a historical attempt with the latest attempts and current generation inputs. */
export function sectionFreshness(attempt: SectionAttempt & { manifest: ExecutionManifest }, history: (SectionAttempt & { manifest: ExecutionManifest })[], current: ExecutionManifest): SectionFreshness {
  const reasons = new Set<SectionFreshness['reasons'][number]>();
  const visit = (item: SectionAttempt & { manifest: ExecutionManifest }) => {
    if (history.find(row => row.section === item.section)?.id !== item.id) reasons.add('newer_attempt');
    if (generationIdentity(item.manifest, item.section) !== generationIdentity(current, item.section)) reasons.add('generation_inputs_changed');
    for (const dependency of SECTION_DEPENDENCIES[item.section]) {
      const latest = history.find(row => row.section === dependency);
      if (!latest || latest.status !== 'succeeded' || !latest.result || item.prerequisites[dependency] !== latest.id || item.result?.prerequisite_ids[dependency] !== latest.result.output_id) { reasons.add('prerequisite_changed'); continue; }
      visit(latest);
    }
  };
  visit(attempt);
  return { current: reasons.size === 0, reasons: [...reasons] };
}
/** Validate current transitive prerequisites, preserving exact latest-attempt identity rather than older success. */
function bindPrerequisites(manifest: ExecutionManifest, input: StartExecutionInput, history: (SectionAttempt & { manifest: ExecutionManifest })[]): void {
  const required = new Set<DevelopmentSection>();
  const visit = (section: DevelopmentSection) => { for (const dependency of SECTION_DEPENDENCIES[section]) if (!required.has(dependency)) { required.add(dependency); visit(dependency); } };
  if (input.target !== 'all') visit(input.target);
  if (Object.keys(input.prerequisites).some(section => !required.has(section as DevelopmentSection))) throw new DevelopmentError(409, 'invalid_prerequisite', 'Supply exactly the current direct and transitive prerequisite identities.');
  for (const section of required) {
    const latest = history.find(attempt => attempt.section === section);
    const expected = input.prerequisites[section];
    if (!latest || latest.status !== 'succeeded' || !latest.result || !expected || expected.attempt_id !== latest.id || expected.output_id !== latest.result.output_id || generationIdentity(latest.manifest, section) !== generationIdentity(manifest, section)) throw new DevelopmentError(409, 'invalid_prerequisite', 'Run the latest successful prerequisites with these source snapshots and generation settings first, then reload their exact identities.');
    manifest.prerequisites[section] = { attempt_id: latest.id, output_id: latest.result.output_id, result: latest.result };
  }
  for (const section of required) for (const dependency of SECTION_DEPENDENCIES[section]) {
    const result = manifest.prerequisites[section]!.result;
    const dependencyBinding = manifest.prerequisites[dependency]!;
    const attempt = history.find(attempt => attempt.id === manifest.prerequisites[section]!.attempt_id)!;
    if (result.prerequisite_ids[dependency] !== dependencyBinding.output_id || attempt.prerequisites[dependency] !== dependencyBinding.attempt_id) throw new DevelopmentError(409, 'stale_lineage', 'A newer upstream attempt invalidated this downstream result. Rerun its prerequisites in order.');
  }
}
/** Capture reference provenance without exposing reference content to generation. */
export function referenceIdentities(documents: readonly DevelopmentDocument[]): ReferenceIdentity[] {
  return documents.filter(document => document.role === 'reference').map(({ id, section, sha256, parsed_sha256, source_document_ids }) => ({ id, section, sha256, parsed_sha256, source_document_ids: [...(source_document_ids ?? [])] }));
}
/** Stable evaluator and reference hashes for evaluation association identity. */
export function evaluationBindings(config: ExecutionManifest['config'], documents: readonly DevelopmentDocument[], referenceIds: readonly string[]): { evaluator_identity: string; reference_identity: string } {
  const available = new Map(referenceIdentities(documents).map(reference => [reference.id, reference]));
  return { evaluator_identity: hash(config.evaluator), reference_identity: hash([...referenceIds].sort().map(id => available.get(id) ?? { id, missing: true })) };
}
/** Parse optional bounded owner-supplied execution controls for freshness. */
export function historyConfig(request: Request): ExecutionManifest['config'] | undefined {
  const raw = new URL(request.url).searchParams.get('config');
  if (raw === null) return undefined;
  if (raw.length > 16000) throw new DevelopmentError(400, 'invalid_config', 'The history configuration is too large.');
  return executionConfigSchema.parse(JSON.parse(raw));
}
export type AttemptHistoryEvaluation = Omit<EvaluationAssociation, 'status'> & { status: EvaluationAssociation['status'] | import('./evaluation-store').EvaluationStatus; freshness: 'current' | 'outdated' | 'unavailable'; reasons: ('attempt_changed' | 'evaluator_changed' | 'references_changed')[]; profile_version?: number };
export type AttemptHistoryMetadata = { freshness: SectionFreshness; evaluations: readonly AttemptHistoryEvaluation[] };
/** Compute owner history metadata using the current draft and optionally supplied controls. */
export async function historyMetadata(experimentId: string, executions: Execution[], config?: ExecutionManifest['config']): Promise<Record<string, AttemptHistoryMetadata>> {
  const experiment = await getExperiment(experimentId);
  const history = await sectionHistory(experimentId);
  const durableEvaluations = await listAttemptEvaluations(experimentId, executions.flatMap(execution => execution.sections.map(section => section.id)));
  const entries = await Promise.all(executions.flatMap(execution => execution.sections.map(async section => {
    const historical = history.find(item => item.id === section.id)!;
    const current: ExecutionManifest = { ...execution.manifest, sources: experiment.documents.filter(document => document.role === 'source'), config: config ?? execution.manifest.config, code_identity: executionCodeIdentity(), modules: Object.fromEntries(SECTIONS.map(name => [name, developmentModuleIdentity(name)])) as ExecutionManifest['modules'], prompts: Object.fromEntries(SECTIONS.map(name => [name, { id: 'development-baseline-v1', instruction: '' }])) as ExecutionManifest['prompts'] };
    const latest = history.find(item => item.section === section.section)!;
    const associations = await listEvaluationAssociations(experimentId, section.id);
    const evaluations = associations.map(item => {
      const referenceIds = item.reference_ids ?? referenceIdentities(experiment.documents).map(reference => reference.id);
      const expected = { attempt_id: latest.id, output_id: latest.result?.output_id ?? '', profile_id: item.profile_id, reference_ids: referenceIds, ...evaluationBindings(current.config, experiment.documents, referenceIds) };
      const saved = { ...item, reference_ids: item.reference_ids ?? referenceIds };
      const reasons: ('attempt_changed' | 'evaluator_changed' | 'references_changed')[] = [];
      if (item.attempt_id !== expected.attempt_id || item.output_id !== expected.output_id) reasons.push('attempt_changed');
      if (item.evaluator_identity !== expected.evaluator_identity) reasons.push('evaluator_changed');
      if (item.reference_identity !== expected.reference_identity) reasons.push('references_changed');
      return { ...item, freshness: evaluationFreshness(saved, expected), reasons };
    });
    const durable = durableEvaluations.filter(item => item.manifest.attempt_id === section.id).map(item => ({ id: item.id, experiment_id: item.experiment_id, attempt_id: item.manifest.attempt_id, output_id: item.manifest.output_id, profile_id: item.manifest.profile.id, profile_version: item.manifest.profile.version, evaluator_identity: hash(item.manifest.config.sections[item.manifest.section]), reference_identity: hash(item.manifest.references), reference_ids: item.manifest.references.map(reference => reference.id), status: item.status, created_at: item.created_at, freshness: 'unavailable' as const, reasons: [] }));
    return [section.id, { freshness: sectionFreshness(historical, history, current), evaluations: [...durable, ...evaluations] }] as const;
  })));
  return Object.fromEntries(entries);
}
/** Publish an immutable fresh attempt only after configuration, availability and current-lineage checks. */
export async function startExecution(experimentId: string, raw: StartExecutionInput) {
  const input = startExecutionSchema.parse(raw);
  if (!deliveryConfiguration().available) throw new DevelopmentError(503, 'delivery_unavailable', deliveryConfiguration().reason!);
  const experiment = await getExperiment(experimentId);
  requireRevision(experiment, input.revision);
  const sections = input.target === 'all' ? [...SECTIONS] : [input.target];
  for (const section of sections) await requireSectionAi(section);
  const sources = experiment.documents.filter(document => document.role === 'source');
  if (!sources.length || sources.length > 100 || sources.some(source => source.compatibility !== 'compatible' || hash(source.parsed) !== source.parsed_sha256)) throw new DevelopmentError(422, 'invalid_sources', 'Choose 1–100 unchanged compatible source snapshots before starting.');
  let routes;
  try { routes = freezeRoutes(input.config, sections); }
  catch (error) { if (error instanceof NoRouteError) throw new DevelopmentError(409, 'route_unavailable', error.message); throw error; }
  const manifest: ExecutionManifest = {
    revision: input.revision, target: input.target, config: input.config, references: referenceIdentities(experiment.documents), sources: structuredClone(sources), routes,
    code_identity: executionCodeIdentity(),
    modules: Object.fromEntries(SECTIONS.map(section => [section, developmentModuleIdentity(section)])) as ExecutionManifest['modules'],
    prompts: Object.fromEntries(SECTIONS.map(section => [section, { id: 'development-baseline-v1', instruction: '' }])) as ExecutionManifest['prompts'],
    prerequisites: {}, retry_policy: { http_max_attempts: 1, uncertain_resend: false, user_rerun: 'fresh_attempt_may_charge' },
  };
  return reserveExecution(experimentId, input.revision, sections, history => { bindPrerequisites(manifest, input, history); return manifest; });
}
