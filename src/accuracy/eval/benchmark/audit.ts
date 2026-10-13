/** Pure existing completeness process, isolated from DB-backed critic/routing. */
import { z } from 'zod';
import { COMPLETENESS_CRITIC_SYSTEM, completenessCriticUser } from '../../modules/completeness-audit/prompts';
import { completenessVerdictSchema, selectBlocksToJudge, flagsFromVerdicts, citedBlockIds, collapseAuditText, excerptFromBlock, type MissFlag, type CompletenessVerdict } from '../../modules/completeness-audit/engine';
import type { FrozenReferencePack } from './inputs';
import type { ExtractFinding } from './extract';
import type { ScoringStage } from './scoring';
import { artifactDigest } from './artifacts';

/** Identity covers reused prompt, selection/check code and exact batching policy. */
export const FROZEN_AUDIT_PROCESS_HASH = artifactDigest({ system: COMPLETENESS_CRITIC_SYSTEM,
  user: completenessCriticUser.toString(), selection: selectBlocksToJudge.toString(),
  verdict: z.toJSONSchema(completenessVerdictSchema, { unrepresentable: 'any' }),
  flags: flagsFromVerdicts.toString(), cited: citedBlockIds.toString(), collapse: collapseAuditText.toString(), excerpt: excerptFromBlock.toString(),
  prepare: prepareAudit.toString(), validate: validateAudit.toString(), refinement: 'missed-requires-gap-or-tactic', batchSize: 25, policy: 'all-uncited-blocks;no-invalid-answer-retry;v1' });
export type AuditChunk = { id: string; system: string; user: string; blockIds: string[] };
export type AuditOutput = { chunks: AuditChunk[]; verdicts: CompletenessVerdict[]; flags: MissFlag[]; complete: boolean };
export type AuditHumanRecords = { flags: { blockId: string; goldIds: string[]; incorrect: boolean; rationale: string }[] };
export type AuditScore = { genuineOmissionsFlagged: string[]; missedOmissions: string[]; incorrectFlags: string[]; provisional: boolean };

/** Build the same complete uncited-block audit input for either extractor.
 * Accepts source only, never evaluator gold or extraction configuration identity.
 */
export function prepareAudit(pack: Pick<FrozenReferencePack, 'packId' | 'source'>, stage: ScoringStage, findings: ExtractFinding[]): AuditChunk[] {
  const claims = findings.map(f => ({ id: f.id, claim_type: stage === 'need_extract' ? 'gap' : 'tactic', statement: f.statement, source_file_id: pack.packId, provenance: f.citation.valid ? f.provenance : [] }));
  const selection = selectBlocksToJudge({ blocks: pack.source.blocks.map((b, index) => ({ ...b, index, source_file_id: pack.packId })), claims });
  const chunks: AuditChunk[] = [];
  for (let i = 0; i < selection.to_judge.length; i += 25) {
    const blocks = selection.to_judge.slice(i, i + 25);
    const user = completenessCriticUser({ source_file_id: pack.packId, claims, blocks: blocks.map(b => ({ ...b, heading: b.heading ?? null })) });
    chunks.push({ id: artifactDigest({ stage, user, process: FROZEN_AUDIT_PROCESS_HASH }), system: COMPLETENESS_CRITIC_SYSTEM, user, blockIds: blocks.map(b => b.id) });
  }
  return chunks;
}
/** Strictly validate exactly one answer per asked block; missing/duplicate answers fail. */
export function validateAudit(chunk: AuditChunk, raw: unknown): CompletenessVerdict[] {
  const verdicts = z.object({ verdicts: z.array(completenessVerdictSchema) }).parse(raw).verdicts;
  if (verdicts.length !== chunk.blockIds.length || new Set(verdicts.map(v => v.block_id)).size !== verdicts.length || verdicts.some(v => !chunk.blockIds.includes(v.block_id))) throw new Error('Incomplete audit answers');
  return verdicts;
}
/** Convert saved verdicts to existing flags; cannot modify extraction findings. */
export function auditOutput(pack: Pick<FrozenReferencePack, 'packId' | 'source'>, chunks: AuditChunk[], verdicts: CompletenessVerdict[]): AuditOutput {
  return { chunks, verdicts, flags: flagsFromVerdicts(pack.source.blocks.map((b, index) => ({ ...b, index, source_file_id: pack.packId })), new Map(verdicts.map(v => [v.block_id, v]))), complete: verdicts.length === chunks.reduce((n, c) => n + c.blockIds.length, 0) };
}
/** Human flag judgments are separate from content scoring. No flag earns recall. */
export function scoreAudit(output: AuditOutput, omissions: string[], records: AuditHumanRecords | null): AuditScore {
  const flags = output.flags.map(f => f.block_id), rows = records?.flags ?? [];
  if (new Set(rows.map(r => r.blockId)).size !== rows.length || rows.some(r => !flags.includes(r.blockId) || !r.rationale.trim() || r.incorrect === (r.goldIds.length > 0) || new Set(r.goldIds).size !== r.goldIds.length || r.goldIds.some(g => !omissions.includes(g)))) throw new Error('Invalid human audit judgments');
  const genuine = [...new Set(rows.flatMap(r => r.goldIds))];
  return { genuineOmissionsFlagged: genuine, missedOmissions: omissions.filter(g => !genuine.includes(g)), incorrectFlags: rows.filter(r => r.incorrect).map(r => r.blockId), provisional: !records || rows.length !== flags.length || !output.complete };
}
