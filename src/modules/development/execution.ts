/** Validate owner execution requests and freeze source-only generation lineage before publication. */
import { z } from 'zod';
import { assertAiEnabled, AiDisabledError } from '@/modules/kernel/ai-switch';
import { sectionOfStage } from '@/modules/kernel/ai-sections';
import { NoRouteError } from '@/modules/llm/provider';
import { canonicalParsedJson, sha256 } from './documents';
import { executionConfigSchema, SECTION_DEPENDENCIES, SECTION_STAGES } from './execution-schema';
import { sectionSchema, DevelopmentError, type DevelopmentSection } from './schema';
import { getExperiment, requireRevision } from './store';
import { developmentModuleIdentity } from './stage-execution';
import { freezeRoutes } from './routes';
import { reserveExecution, type ExecutionManifest, type SectionAttempt } from './execution-store';
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
    revision: input.revision, target: input.target, config: input.config, sources: structuredClone(sources), routes,
    code_identity: executionCodeIdentity(),
    modules: Object.fromEntries(SECTIONS.map(section => [section, developmentModuleIdentity(section)])) as ExecutionManifest['modules'],
    prompts: Object.fromEntries(SECTIONS.map(section => [section, { id: 'development-baseline-v1', instruction: '' }])) as ExecutionManifest['prompts'],
    prerequisites: {}, retry_policy: { http_max_attempts: 1, uncertain_resend: false, user_rerun: 'fresh_attempt_may_charge' },
  };
  return reserveExecution(experimentId, input.revision, sections, history => { bindPrerequisites(manifest, input, history); return manifest; });
}
