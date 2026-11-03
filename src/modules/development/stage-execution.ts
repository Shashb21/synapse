/** Repeatable source-only adapters around the four real customer stage computations. */
import { z } from 'zod';
import { buildBlankWorkspace } from '@/lib/iegp/blank';
import { countingCoverages, unlocked } from '@/lib/iegp/engine';
import { EVIDENCE_DOMAINS, TACTIC_STATUSES, TACTIC_TYPES } from '@/lib/iegp/enums';
import { judgementReferenceSchema } from '@/lib/iegp/judgement-references';
import type { IegpState } from '@/lib/iegp/types';
import type { JsonCompletion, ModuleContext, ModuleResult, RunHandle, ResolvedRoute } from '@/modules/kernel/contracts';
import { withPromptVariant } from '@/modules/kernel/prompt-variant';
import type { ParsedDocumentRecord } from '@/modules/stages/s1-parse/module';
import { gapExtractModule } from '@/modules/stages/s2-gap-extract/module';
import { tacticExtractModule } from '@/modules/stages/s3-tactic-extract/module';
import { kgMappingModule, developmentMappingCoverages, mappingTableRowSchema, type MappingTableRow } from '@/modules/stages/s4-kg-mapping/module';
import { partialSplitModule } from '@/modules/stages/s6-partial-split/module';
import { canonicalParsedJson, sha256 } from './documents';
import { DevelopmentError, type DevelopmentDocument, type DevelopmentSection } from './schema';
import { SECTION_DEPENDENCIES, SECTION_STAGES, type ExecutionMode } from './execution-schema';

export type SectionModuleIdentity = { id: string; version: string };
export type SectionPromptIdentity = { id: string; instruction: string };
export type DevelopmentSectionResult = {
  section: DevelopmentSection;
  mode: ExecutionMode;
  generation_status: 'succeeded' | 'rejected' | 'not_applicable';
  review_status: 'unreviewed';
  reason: string | null;
  output: unknown;
  candidates: Record<string, unknown>[];
  raw_result: ModuleResult<unknown>;
  model_outputs: { request: Parameters<JsonCompletion>[0]; response: unknown }[];
  local_state: IegpState;
  source_identity: string;
  prerequisite_ids: Partial<Record<DevelopmentSection, string>>;
  output_id: string;
  trace_id: string;
  module_identity: SectionModuleIdentity;
  prompt_identity: SectionPromptIdentity;
  omitted_roles: string[];
};
export type ExecuteDevelopmentSectionInput = {
  section: DevelopmentSection;
  sources: readonly DevelopmentDocument[];
  prerequisites: Partial<Record<DevelopmentSection, DevelopmentSectionResult>>;
  mode?: ExecutionMode;
  recorder: RunHandle;
  complete: JsonCompletion;
  route?: ResolvedRoute;
  module_identity?: SectionModuleIdentity;
  prompt_identity?: SectionPromptIdentity;
};
const modules = { gap_extraction: gapExtractModule, tactic_extraction: tacticExtractModule, matching_coverage: kgMappingModule, partial_splitting: partialSplitModule };
const hash = (value: unknown) => sha256(canonicalParsedJson(value));
const baseCandidate = z.object({ id: z.string().min(1), document_id: z.string().min(1), source_id: z.string().min(1), name: z.string().min(1), source_quote: z.string().min(1) });
const gapCandidate = baseCandidate.extend({ statement: z.string().min(1), domain: z.enum(EVIDENCE_DOMAINS) }).passthrough();
const tacticCandidate = baseCandidate.extend({ type: z.enum(TACTIC_TYPES), status: z.enum(TACTIC_STATUSES), evidence_question: z.string().min(1) }).passthrough();
// Match S2's draft boundary: incomplete drafts may be repaired, but empty rows must not disappear.
const initialGapDraft = z.record(z.string(), z.unknown()).refine(
  row => ['name', 'statement', 'domain', 'source_quote'].some(field => typeof row[field] === 'string' && row[field].trim().length > 0),
  'Every initial gap row must contain a nonempty extraction field.',
);
// Validate supplied citations before S4's parser can normalize malformed references to [].
const mappingReferenceReply = z.object({
  rows: z.array(z.object({
    mappings: z.array(z.object({ references: z.array(judgementReferenceSchema).optional() }).passthrough()),
  }).passthrough()),
});
const blockSchema = z.object({ id: z.string().min(1), text: z.string().min(1), heading: z.string().optional().default(''), location: z.string().optional().default('') }).passthrough();

/** Hash the complete immutable result payload; downstream prerequisites must retain this identity. */
export function developmentOutputIdentity(result: Omit<DevelopmentSectionResult, 'output_id'> | DevelopmentSectionResult): string {
  const { output_id: ignored, ...payload } = result as DevelopmentSectionResult;
  void ignored;
  return hash(payload);
}

/** Bind frozen module versions before any computation or paid dispatch. */
export function developmentModuleIdentity(section: DevelopmentSection): SectionModuleIdentity {
  const manifest = modules[section].manifest;
  return { id: manifest.id, version: manifest.version };
}

/** Validate immutable snapshots and map their IDs directly to stage document/source IDs. */
function parsedSources(sources: readonly DevelopmentDocument[]): ParsedDocumentRecord[] {
  if (!sources.length || sources.length > 100 || new Set(sources.map(source => source.id)).size !== sources.length) throw new DevelopmentError(422, 'invalid_sources', 'Choose 1–100 unique source snapshots.');
  return sources.map(source => {
    if (source.role !== 'source' || source.compatibility !== 'compatible' || hash(source.parsed) !== source.parsed_sha256) throw new DevelopmentError(422, 'invalid_sources', 'Generation accepts only unchanged compatible source snapshots.');
    const parsed = z.object({ blocks: z.array(blockSchema).min(1).max(20000) }).parse(source.parsed);
    if (new Set(parsed.blocks.map(block => block.id)).size !== parsed.blocks.length) throw new DevelopmentError(422, 'invalid_sources', 'Source block IDs must be unique.');
    const characters = parsed.blocks.reduce((count, block) => count + block.text.length, 0);
    return { id: source.id, file_id: source.id, source_id: source.id, parser: source.parser.name, parser_version: source.parser.version, blocks: parsed.blocks.map(block => ({ ...block, source_id: source.id })), quality: { blocks: parsed.blocks.length, characters, avg_block_chars: characters / parsed.blocks.length, empty_blocks: 0, need_cue_blocks: 0, tactic_cue_blocks: 0, warnings: [] }, parsed_at: source.parsed_at, duration_ms: 0 };
  });
}

/** Build an empty domain context with only the supplied source text, never live customer ledgers. */
function sourceState(sources: readonly DevelopmentDocument[], documents: ParsedDocumentRecord[]): IegpState {
  const state = buildBlankWorkspace();
  state.audit = [];
  state.sources = documents.map(document => ({ id: document.source_id, filename: sources.find(source => source.id === document.id)!.filename, title: sources.find(source => source.id === document.id)!.filename, source_type: 'other_internal', stakeholder_function: 'evidence_lead', ingested_at: document.parsed_at, full_text: document.blocks.map(block => block.text).join('\n') }));
  state.blocks = documents.flatMap(document => document.blocks.map(block => ({ id: `${document.source_id}:${block.id}`, source_id: document.source_id, heading: block.heading ?? '', text: block.text, location: block.location ?? '' })));
  return state;
}

/** Verify real extraction fields and verbatim source citations before they become dependencies. */
function extractionCandidates(section: DevelopmentSection, rows: unknown[], documents: ParsedDocumentRecord[]): Record<string, unknown>[] {
  return rows.map(raw => {
    const candidate = (section === 'gap_extraction' ? gapCandidate : tacticCandidate).parse(raw);
    const document = documents.find(document => document.id === candidate.document_id && document.source_id === candidate.source_id);
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!document || !normalize(document.blocks.map(block => block.text).join(' ')).includes(normalize(candidate.source_quote))) throw new DevelopmentError(422, 'invalid_citation', 'Every extraction must quote its supplied source document.');
    return candidate;
  });
}

/** Project model proposals into local domain types. Candidate state never asserts human acceptance. */
function projectExtraction(state: IegpState, section: DevelopmentSection, candidates: Record<string, unknown>[], traceId: string): void {
  if (section === 'gap_extraction') candidates.forEach((raw, index) => {
    const row = gapCandidate.parse(raw);
    const needId = `${row.id}:need`;
    state.gaps.push({ id: row.id, name: row.name, statement: row.statement, domain: row.domain, objective_id: '', status: 'candidate', exclusion_reason: null, exclusion_note: null, status_lock: unlocked(), parent_gap_id: null, computed_status: null, status_override: null, retired: false, human_validated: false, parked_at: null, parked_reason: null, settings: [], metadata: { stakeholders: [], geography: '', regional_nuances: '', notes: '' }, number: index + 1 });
    state.needs.push({ id: needId, statement: row.statement, domain: row.domain, stakeholder: 'evidence_lead', objective_id: '', decision_supported: '', geography: '', population: '', intervention: '', comparator: '', outcome: '', timing: '', source_id: row.source_id, source_quote: row.source_quote, confidence: null, status: 'candidate', status_lock: unlocked(), run_id: traceId, candidate_row_id: row.id, block_id: state.blocks.find(block => block.source_id === row.source_id && block.text.includes(row.source_quote))?.id ?? null });
    state.need_gap_links.push({ gap_id: row.id, need_id: needId, role: 'primary' });
  });
  else candidates.forEach(raw => {
    const row = tacticCandidate.parse(raw);
    state.tactics.push({ id: row.id, name: row.name, type: row.type, description: '', evidence_question: row.evidence_question, population: '', intervention: '', comparator: '', outcomes: '', geography: '', data_source: '', study_design: '', lifecycle_stage: '', status: row.status, review_status: 'candidate', start_date: null, evidence_available: null, owner: '', function: 'evidence_lead', budget: null, intended_use: '', lock: unlocked(), source_quote: row.source_quote });
  });
}

/**
 * Run a real frozen stage with injected completion; no provider or customer-store dispatch occurs here.
 *
 * Parameters
 * ----------
 * args : ExecuteDevelopmentSectionInput
 *     Source snapshots, exact successful prerequisites, stable recorder and injected role-aware completion.
 *
 * Returns
 * -------
 * Promise<DevelopmentSectionResult>
 *     Structurally checked output, unreviewed proposals and experiment-local domain projection.
 *
 * Raises
 * ------
 * DevelopmentError
 *     Invalid snapshots, stale/failed prerequisites or invalid source/reference citations.
 * Error
 *     The real stage rejects malformed model structure. Completion errors/yields propagate unchanged.
 */
export async function executeDevelopmentSection(args: ExecuteDevelopmentSectionInput): Promise<DevelopmentSectionResult> {
  const mode = args.mode ?? 'standard';
  const sources = structuredClone(args.sources);
  const documents = parsedSources(sources);
  const sourceIdentity = hash(sources.map(source => ({ id: source.id, filename: source.filename, sha256: source.sha256, parsed_sha256: source.parsed_sha256, parser: source.parser, parsed_at: source.parsed_at })));
  const moduleIdentity = developmentModuleIdentity(args.section);
  if (args.module_identity && canonicalParsedJson(args.module_identity) !== canonicalParsedJson(moduleIdentity)) throw new DevelopmentError(409, 'module_changed', 'The frozen stage implementation changed. Start a new execution.');
  const promptIdentity = structuredClone(args.prompt_identity ?? { id: 'development-baseline-v1', instruction: '' });
  const prerequisiteIds: Partial<Record<DevelopmentSection, string>> = {};
  const dependencies = SECTION_DEPENDENCIES[args.section];
  if (Object.keys(args.prerequisites).some(section => !dependencies.includes(section as DevelopmentSection))) throw new DevelopmentError(422, 'invalid_prerequisite', 'Supply exactly the section dependencies.');
  for (const dependency of dependencies) {
    const prior = args.prerequisites[dependency];
    if (!prior || prior.section !== dependency || prior.generation_status !== 'succeeded' || prior.source_identity !== sourceIdentity || prior.output_id !== developmentOutputIdentity(prior)) throw new DevelopmentError(409, 'invalid_prerequisite', 'Run the current successful prerequisites for these exact source snapshots first.');
    prerequisiteIds[dependency] = prior.output_id;
  }
  let state = sourceState(sources, documents);
  if (args.section === 'matching_coverage') {
    const gaps = args.prerequisites.gap_extraction!.local_state;
    state.gaps = structuredClone(gaps.gaps); state.needs = structuredClone(gaps.needs); state.need_gap_links = structuredClone(gaps.need_gap_links);
    state.tactics = structuredClone(args.prerequisites.tactic_extraction!.local_state.tactics);
  } else if (args.section === 'partial_splitting') state = structuredClone(args.prerequisites.matching_coverage!.local_state);
  const modelOutputs: DevelopmentSectionResult['model_outputs'] = [];
  const complete: JsonCompletion = async request => {
    if (!request.role) throw new Error('Experiment completions require an explicit originating role.');
    if (mode === 'single_pass' && request.role !== 'proposer') throw new Error('Single pass cannot invoke omitted roles.');
    const actual = { ...request, system: promptIdentity.instruction ? `${request.system}\n\nFrozen experiment instruction:\n${promptIdentity.instruction}` : request.system };
    const response = await args.complete(actual);
    if (request.role === 'proposer' || request.role === 'reviser') {
      if (args.section === 'gap_extraction') {
        const rowSchema = request.purpose.startsWith('gap-proposer:') ? initialGapDraft : z.unknown();
        z.object({ gaps: z.array(rowSchema) }).parse(response);
      }
      if (args.section === 'tactic_extraction') z.object({ tactics: z.array(z.unknown()) }).parse(response);
      if (args.section === 'matching_coverage') mappingReferenceReply.parse(response);
    }
    modelOutputs.push({ request: structuredClone(actual), response: structuredClone(response) });
    return structuredClone(response);
  };
  const ctx: ModuleContext = { workspace_id: 'development-isolated', actor: { name: 'Development experiment', function: 'evidence_lead' }, role: 'owner', run: args.recorder, execution_policy: mode, execution_scope: 'development', route: args.route ?? { stage: SECTION_STAGES[args.section], provider_id: 'injected', provider_label: 'Injected experiment completion', model: 'injected', auth: 'api_key', connected: true, params: { temperature: 0.2, max_tokens: 16000 }, fallbacks: [], degraded: false, reason: null }, complete, ai: true, replay: { evaluation: true, input: {}, facts: { documents, state: args.section === 'partial_splitting' ? { ...state, coverages: state.coverages.filter(coverage => coverage.overall !== 'not_relevant' && coverage.overall !== 'unassessed') } : state }, examples: [], module_id: moduleIdentity.id, module_version: moduleIdentity.version, prompt_version: promptIdentity.id } };
  let rawResult: ModuleResult<unknown>;
  let candidates: Record<string, unknown>[] = [];
  let status: DevelopmentSectionResult['generation_status'] = 'succeeded';
  let reason: string | null = null;
  if (args.section === 'gap_extraction' || args.section === 'tactic_extraction') {
    const stage = args.section === 'gap_extraction' ? gapExtractModule : tacticExtractModule;
    const input = stage.inputSchema.parse({ document_ids: documents.map(document => document.id), dry_run: true });
    rawResult = await withPromptVariant<ModuleResult<unknown>>('v1.0-baseline', () => stage.run(input, ctx));
    stage.outputSchema.parse(rawResult.output);
    const output = rawResult.output as { accepted: unknown[]; rejected: unknown[] };
    candidates = extractionCandidates(args.section, mode === 'single_pass' ? rawResult.agentic?.unreviewed ?? [] : output.accepted, documents);
    // Rejected candidates remain inspectable but invalid citations still fail the section.
    extractionCandidates(args.section, output.rejected, documents);
    if (!candidates.length && (output.rejected.length || rawResult.agentic?.withdrawn.length)) status = 'rejected';
    projectExtraction(state, args.section, candidates, args.recorder.id);
  } else if (args.section === 'matching_coverage') {
    rawResult = await kgMappingModule.run(kgMappingModule.inputSchema.parse({ dry_run: true }), ctx);
    const output = kgMappingModule.outputSchema.parse(rawResult.output);
    const rows = (mode === 'single_pass' ? rawResult.agentic?.unreviewed ?? [] : output.accepted).map(row => mappingTableRowSchema.parse(row));
    // Validate the commit-boundary citation rules even though evaluation never commits.
    developmentMappingCoverages(state, output.rows, args.recorder.id);
    state.coverages = developmentMappingCoverages(state, rows, args.recorder.id);
    candidates = rows;
    if (!rows.length && (output.rejected.length || output.withdrawn.length)) status = 'rejected';
  } else {
    const rows = args.prerequisites.matching_coverage!.candidates as MappingTableRow[];
    const eligible = rows.filter(row => row.mapping_status === 'partially_addressed' && countingCoverages(state.coverages.filter(coverage => coverage.gap_id === row.gap_id && coverage.overall !== 'not_relevant' && coverage.overall !== 'unassessed'), state.tactics, state.expansions).length);
    if (!eligible.length) {
      status = 'not_applicable'; reason = 'No partially addressed gap has a completed, ongoing or planned counting tactic. Run matching and coverage with an eligible source tactic first.';
      rawResult = { output: { proposals: [] }, summary: reason };
    } else {
      const results = [];
      for (const row of eligible) {
        const result = await partialSplitModule.run(partialSplitModule.inputSchema.parse({ gap_id: row.gap_id }), ctx);
        const output = partialSplitModule.outputSchema.parse(result.output);
        results.push(result);
        const proposed = mode === 'single_pass' ? result.agentic?.unreviewed ?? [] : output.proposal ? [output.proposal] : [];
        candidates.push(...proposed as Record<string, unknown>[]);
      }
      rawResult = { output: { proposals: candidates }, summary: `${candidates.length} isolated split proposal(s)`, agentic: { proposed: results.flatMap(result => result.agentic?.proposed ?? []), unreviewed: results.flatMap(result => result.agentic?.unreviewed ?? []), judged: results.flatMap(result => result.agentic?.judged ?? []), withdrawn: results.flatMap(result => result.agentic?.withdrawn ?? []) } };
      if (!candidates.length) status = 'rejected';
      // Preserve the original per-gap stage results alongside aggregated output.
      (rawResult.output as { proposals: unknown[]; stage_results?: unknown[] }).stage_results = results;
    }
  }
  const payload: Omit<DevelopmentSectionResult, 'output_id'> = { section: args.section, mode, generation_status: status, review_status: 'unreviewed', reason, output: rawResult.output, candidates, raw_result: rawResult, model_outputs: modelOutputs, local_state: state, source_identity: sourceIdentity, prerequisite_ids: prerequisiteIds, trace_id: args.recorder.id, module_identity: moduleIdentity, prompt_identity: promptIdentity, omitted_roles: mode === 'single_pass' ? ['critic', 'reviser', 'internal_judge'] : [] };
  return { ...payload, output_id: developmentOutputIdentity(payload) };
}
