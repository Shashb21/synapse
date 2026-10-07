/** Immutable prompt candidates generated from revalidated lessons and frozen, lineage-separated evidence. */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor, StageId, EvalCase } from "./contracts";
import { listDecisionExamples, scrubLesson, workspaceEntityNames, type DecisionExample } from "./decision-examples";
import { ensurePlatformSchema, sharedDb } from "./db";
import * as tables from "./schema";
import { newId, nowIso } from "./ids";
import { assertAiEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";
import { isTestStub } from "./llm";
import { resolveRoute, completionFor, routeConfig, type RouteConfig } from "./routing";
import { RunRecorder, openRun, closeRun } from "./observability";
import { activePromptVersion } from "./prompt-variant";
import { DEFAULT_SCHEMA, DEFAULT_WORKSPACE_ID, runInWorkspace, scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";

import { evidenceHash, frozenReplayCase, type FrozenReplayCase } from "./decision-replay";
import { moduleById } from "./registry";

/** Link S9 proposal IDs to their proven pre-generation gap slot, never inferred text. */
function decisionSubjects(example: DecisionExample): string[] {
  if (example.kind !== "s9_proposal") return [example.subject_id];
  const slots = frozenReplayCase(example)?.facts.proposal_slots as Record<string, unknown> | undefined;
  const gaps = Object.entries(slots ?? {}).filter(([, values]) => Array.isArray(values) && values.includes(example.ai_input.slot_id)).map(([id]) => id);
  return gaps.length === 1 ? [example.subject_id, gaps[0]] : [example.subject_id];
}

/** Reserve the full execution scope of historical replay, including library provenance. */
function replayLineage(examples: DecisionExample[], heldout: Set<string>) {
  const subjects = new Set<string>(), runs = new Set<string>();
  const exclusions: Record<string, string> = {};
  for (const example of examples.filter(row => heldout.has(row.id))) {
    const snapshot = frozenReplayCase(example);
    if (!snapshot || !["S4", "S8", "S9"].includes(snapshot.stage)) continue;
    runs.add(snapshot.run_id);
    const state = snapshot.facts.state as { gaps: { id: string }[]; tactics?: { id: string }[] };
    const input = snapshot.input as { gap_ids?: string[] };
    // Broad runs include all frozen gap subjects, even if just one human target
    // was captured. Explicit gap lists give a safe (possibly conservative) scope.
    for (const id of input.gap_ids?.length ? input.gap_ids : state.gaps.map(gap => gap.id)) subjects.add(id);
    if (snapshot.stage === "S9") {
      const provenance = snapshot.facts.proposal_lineage as { subject_id: string; gap_id: string; tactic_id: string | null; run_id: string | null; origin: string }[] | undefined;
      if (!Array.isArray(provenance)) {
        exclusions[example.id] = "Frozen S9 replay library proposal lineage is unavailable.";
        continue;
      }
      const library = new Set((state.tactics ?? []).map(tactic => tactic.id));
      for (const row of provenance.filter(row => row.tactic_id && library.has(row.tactic_id))) {
        subjects.add(row.subject_id); subjects.add(row.gap_id);
        if (row.run_id) runs.add(row.run_id);
        else if (row.origin !== "human") exclusions[example.id] = "Frozen S9 replay library has an unknown originating run.";
      }
    }
  }
  return { subjects, runs, exclusions };
}

/** Reserve only originating held-out facts, never today's workspace or arbitrary snapshots. */
async function reserveGold(examples: DecisionExample[], heldout: Set<string>): Promise<GoldReservation> {
  const result: GoldReservation = { version: 1, cases: [], excluded_ids: [], subject_ids: [], run_ids: [], reason: null };
  const sources = examples.filter(example => heldout.has(example.id)).flatMap(example => {
    const snapshot = frozenReplayCase(example);
    return snapshot ? [snapshot] : [];
  });
  const source = sources.find(snapshot => {
    const module = moduleById(snapshot.module_id);
    return module?.manifest.version === snapshot.module_version && !!module.evals;
  });
  if (!source) return { ...result, reason: "No held-out originating snapshot supports a gold reservation." };
  const module = moduleById(source.module_id)!;
  const heldSubjects = examples.filter(example => heldout.has(example.id)).flatMap(decisionSubjects);
  if (!module.evals!.reserveGold) return { ...result, reason: "Stage has no complete gold subject-lineage reservation contract." };
  const restricted = await module.evals!.reserveGold(structuredClone(source.facts), heldSubjects);
  const facts = restricted.facts;
  const cases = restricted.cases;
  result.reason = restricted.reason ?? null;
  result.subject_ids = [...new Set([...restricted.subject_ids, ...(restricted.lineage_subject_ids ?? [])])];
  const runs = new Set([source.run_id, ...(restricted.lineage_run_ids ?? [])]);
  result.excluded_ids = examples.filter(example => heldout.has(example.id) || decisionSubjects(example).some(id => result.subject_ids.includes(id)) || !!example.run_id && runs.has(example.run_id)).map(example => example.id);
  result.run_ids = [...new Set([...runs, ...examples.filter(example => result.excluded_ids.includes(example.id)).flatMap(example => example.run_id ? [example.run_id] : [])])];
  result.cases = cases.map(testCase => ({ testCase: structuredClone(testCase), snapshot: { ...structuredClone(source), input: module.inputSchema.parse(testCase.input), facts: structuredClone(facts), examples: [] } }));
  if (!result.cases.length && !result.reason) result.reason = "No eligible held-out subjects remain for the stage gold harness.";
  return result;
}

export const REVISION_STAGES = ["S2", "S3", "S4", "S6", "S8", "S9"] as const;
/** One latest lineage group in every five is reserved for testing, with at least one held out. */
const HOLDOUT_GROUP_FRACTION = 0.2;
export type PromptRevisionState = "candidate" | "evaluated" | "active" | "superseded";
export type PromptRevision = {
  id: string; workspace_id: string; stage: StageId; parent_revision: string; instruction_text: string;
  creator: Actor; created_at: string; state: PromptRevisionState; cohort_id: string;
  training_ids: string[]; heldout_ids: string[]; excluded_ids: string[];
  generation_run_id: string; model: string | null; provider_id: string | null;
};
/** Exact cases and context reserved before generation; null marks legacy cohorts. */
export type GoldReservation = {
  version: 1; cases: { testCase: EvalCase<unknown>; snapshot: FrozenReplayCase }[];
  excluded_ids: string[]; subject_ids: string[]; run_ids: string[]; reason: string | null;
};
export type RevisionCohort = {
  id: string; workspace_id: string; stage: StageId; created_at: string;
  training_ids: string[]; heldout_ids: string[]; excluded_ids: string[];
  examples: DecisionExample[]; replay_exclusions: Record<string, string>;
  gold_reservation: GoldReservation | null;
};
type CohortArgs = { stage: StageId; workspace_id: string; exclude_ids: string[] };

/** Group connected originating runs and subjects, then persist the exact evidence before generation. */
export async function freezeRevisionCohort(args: CohortArgs): Promise<RevisionCohort> {
  await ensurePlatformSchema();
  const examples = (await listDecisionExamples({ stage: args.stage, workspace_id: args.workspace_id, limit: null }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  // A connected component keeps indirect links together: A shares run with B; B shares subject with C.
  const groups: DecisionExample[][] = [];
  for (const example of examples) {
    const matches = groups.filter(group => group.some(other => (example.run_id && example.run_id === other.run_id) || (example.kind === other.kind && decisionSubjects(example).some(id => decisionSubjects(other).includes(id)))));
    const joined = [...matches.flat(), example];
    for (const match of matches) groups.splice(groups.indexOf(match), 1);
    groups.push(joined);
  }
  groups.sort((a, b) => a[a.length - 1].created_at.localeCompare(b[b.length - 1].created_at) || a[a.length - 1].id.localeCompare(b[b.length - 1].id));
  const explicit = new Set(args.exclude_ids);
  const heldout = new Set(groups.slice(-Math.max(1, Math.ceil(groups.length * HOLDOUT_GROUP_FRACTION))).flat().map(example => example.id));
  // An explicit exclusion expands to the entire originating group; callers may only enlarge the holdout.
  for (const group of groups) if (group.some(example => explicit.has(example.id))) for (const example of group) explicit.add(example.id);
  const gold_reservation = await reserveGold(examples, heldout);
  for (const id of gold_reservation.excluded_ids) explicit.add(id);
  const replay = replayLineage(examples, heldout);
  for (const example of examples) if (decisionSubjects(example).some(id => replay.subjects.has(id)) || !!example.run_id && replay.runs.has(example.run_id)) explicit.add(example.id);
  gold_reservation.subject_ids.push(...replay.subjects);
  gold_reservation.run_ids.push(...replay.runs);
  // Gold reservations expand through the same complete connected lineage as replay.
  for (const group of groups) if (group.some(example => explicit.has(example.id))) for (const example of group) explicit.add(example.id);
  gold_reservation.excluded_ids = [...explicit].sort();
  const goldLineage = examples.filter(example => explicit.has(example.id));
  gold_reservation.subject_ids = [...new Set([...gold_reservation.subject_ids, ...goldLineage.flatMap(decisionSubjects)])].sort();
  gold_reservation.run_ids = [...new Set([...gold_reservation.run_ids, ...goldLineage.flatMap(example => example.run_id ? [example.run_id] : [])])].sort();
  const replay_exclusions: Record<string, string> = { ...replay.exclusions };
  for (const example of examples) if (!example.replay_input || example.replay_exclusion_reason) replay_exclusions[example.id] = example.replay_exclusion_reason || "No frozen originating stage input is available.";
  const cohort: RevisionCohort = {
    id: newId("prc"), workspace_id: args.workspace_id, stage: args.stage, created_at: nowIso(),
    training_ids: examples.filter(example => !heldout.has(example.id) && !explicit.has(example.id)).map(example => example.id),
    heldout_ids: examples.filter(example => heldout.has(example.id)).map(example => example.id),
    excluded_ids: [...new Set([...heldout, ...explicit])].sort(), examples, replay_exclusions, gold_reservation,
  };
  await sharedDb().insert(tables.promptRevisionCohorts).values(cohort);
  return cohort;
}

/** Retrieve persisted same-workspace frozen evidence for candidate evaluation. */
export async function getRevisionCohort(id: string, workspace_id: string): Promise<RevisionCohort | null> {
  await ensurePlatformSchema();
  const [row] = await sharedDb().select().from(tables.promptRevisionCohorts).where(and(eq(tables.promptRevisionCohorts.id, id), eq(tables.promptRevisionCohorts.workspace_id, workspace_id)));
  return row ? row as RevisionCohort : null;
}

/** Generate another version; no generation outcome changes a live prompt pointer. */
export async function proposePromptRevision(args: CohortArgs & { actor: Actor }): Promise<PromptRevision> {
  if (!REVISION_STAGES.includes(args.stage as typeof REVISION_STAGES[number])) throw new Error("This stage has no captured AI decision lessons.");
  const workspace = await getWorkspace(args.workspace_id);
  if (!workspace && args.workspace_id !== DEFAULT_WORKSPACE_ID) throw new Error("Learning workspace is unavailable.");
  return runInWorkspace({ workspace_id: args.workspace_id, schema: workspace?.schema_name ?? DEFAULT_SCHEMA }, async () => {
    await assertAiEnabled("Prompt revision generation", sectionOfStage(args.stage) ?? undefined);
    const cohort = await freezeRevisionCohort(args);
    const entities = await workspaceEntityNames();
    if (!entities.length) throw new Error("Learning entity context is empty.");
    const training = new Set(cohort.training_ids);
    const lessons = cohort.examples.flatMap(example => {
      if (!training.has(example.id) || example.outcome === "accepted" || example.lesson_status !== "ok" || !example.lesson) return [];
      const lesson = scrubLesson(example.lesson, [JSON.stringify(example.ai_input), JSON.stringify(example.ai_output), JSON.stringify(example.final ?? {}), example.rationale ?? ""], entities);
      return lesson ? [{ id: example.id, lesson }] : [];
    });
    if (!lessons.length) throw new Error("No validated disagreement lessons remain outside the held-out cohort.");
    const pointer = await activeRevisionPointer(args.workspace_id, args.stage);
    const parent = pointer.revision_id ?? activePromptVersion();
    const stub = isTestStub();
    const route = stub ? null : await resolveRoute(args.stage);
    const recorder = new RunRecorder({ workspace_id: args.workspace_id, stage: args.stage, module_id: "learning.prompt-revision", module_version: "1.0.0", actor: args.actor, input: { cohort_id: cohort.id, parent_revision: parent, lesson_count: lessons.length } });
    await openRun(recorder);
    try {
      // No raw answers, customer metadata, example IDs, or held-out lessons enter the completion.
      const response = stub ? { instruction_text: "[Test stub] Keep distinct decision questions separate and require supporting evidence." } : await completionFor(route!, recorder)({
        system: "Draft concise additional instructions for an evidence-planning stage using only general reviewer lessons. Preserve human decisions and require source-grounded evidence. Return JSON only: {\"instruction_text\":\"\"}.",
        user: JSON.stringify({ stage: args.stage, lessons: lessons.map(item => item.lesson) }), purpose: "prompt-revision",
      });
      const parsed = z.object({ instruction_text: z.string().trim().min(1).max(8000) }).strict().parse(response);
      const revision: PromptRevision = {
        id: newId("prv"), workspace_id: args.workspace_id, stage: args.stage, parent_revision: parent,
        instruction_text: parsed.instruction_text, creator: args.actor, created_at: nowIso(), state: "candidate",
        cohort_id: cohort.id, training_ids: lessons.map(item => item.id), heldout_ids: cohort.heldout_ids, excluded_ids: cohort.excluded_ids,
        generation_run_id: recorder.id, model: route?.model ?? null, provider_id: route?.provider_id ?? null,
      };
      await sharedDb().insert(tables.promptRevisions).values(revision);
      await closeRun({ recorder, status: "ok", route: route ?? undefined, output: { revision_id: revision.id, state: revision.state } });
      return revision;
    } catch (error) {
      await closeRun({ recorder, status: "error", route: route ?? undefined, output: {}, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

/** List only the selected workspace's revision records, newest first. */
export async function listPromptRevisions(workspace_id: string): Promise<PromptRevision[]> {
  await ensurePlatformSchema();
  return await sharedDb().select().from(tables.promptRevisions).where(eq(tables.promptRevisions.workspace_id, workspace_id)).orderBy(desc(tables.promptRevisions.created_at)) as PromptRevision[];
}

/** Resolve candidate identity inside the selected workspace. */
export async function getPromptRevision(id: string, workspace_id: string): Promise<PromptRevision | null> {
  await ensurePlatformSchema();
  const [row] = await sharedDb().select().from(tables.promptRevisions).where(and(eq(tables.promptRevisions.id, id), eq(tables.promptRevisions.workspace_id, workspace_id)));
  return row ? row as PromptRevision : null;
}

/** Read the current pointer and its monotonic generation (guards change-away-and-back races). */
export async function activeRevisionPointer(workspace_id: string, stage: StageId): Promise<{revision_id:string|null;generation:number}> {
 await ensurePlatformSchema();
 const rows=await sharedDb().execute(sql`select revision_id,generation from prompt_active_revisions where workspace_id=${workspace_id} and stage=${stage}`);
 return rows[0] ? {revision_id:rows[0].revision_id as string|null,generation:Number(rows[0].generation)} : {revision_id:null,generation:0};
}
/** Immutable before/after history, visible only inside the selected workspace. */
export async function revisionHistory(workspace_id:string) {
 await ensurePlatformSchema();
 return await sharedDb().execute(sql`select * from prompt_revision_history where workspace_id=${workspace_id} order by generation desc, created_at desc`);
}
/** Compare-and-swap the pointer and append history in one transaction. */
export async function activatePromptRevision(args: {revision_id:string;evaluation_id:string;expected_active_id:string|null;actor:Actor}):Promise<PromptRevision> {
 const workspace_id=await scopedWorkspaceId();
 if(!workspace_id) throw new Error('An authorised workspace is required.');
 const revision=await getPromptRevision(args.revision_id,workspace_id);
 if(!revision) throw new Error('Unknown candidate in this workspace.');
 const {getRevisionEvaluation,promotionEligibility,routeIdentity}=await import('./prompt-revision-evals');
 const evaluation=await getRevisionEvaluation(args.evaluation_id,workspace_id);
 if(!evaluation||evaluation.revision_id!==revision.id||!promotionEligibility(evaluation).eligible) throw new Error('Evaluation is missing or ineligible.');
 const cohort=await getRevisionCohort(revision.cohort_id,workspace_id);
 if(!cohort?.gold_reservation?.cases.length || evidenceHash(evaluation.gold_cases)!==evidenceHash(cohort.gold_reservation.cases)) throw new Error('Gold facts were not reserved before generation. Generate a new candidate.');
 const configuredRoute=await routeConfig(revision.stage);
 const route=await resolveRoute(revision.stage,configuredRoute);
 if(routeIdentity(route)!==evaluation.route_hash) throw new Error('Routing changed since evaluation. Evaluate again.');
 const {activeModule}=await import('./registry');const module=await activeModule(revision.stage);
 if(module.manifest.id!==evaluation.module_id||module.manifest.version!==evaluation.module_version) throw new Error('Stage implementation changed since evaluation.');
 await sharedDb().transaction(async tx=>{
  await tx.execute(sql`insert into prompt_active_revisions(workspace_id,stage) values(${workspace_id},${revision.stage}) on conflict do nothing`);
  const rows=await tx.execute(sql`select * from prompt_active_revisions where workspace_id=${workspace_id} and stage=${revision.stage} for update`);
  const pointer=rows[0];
  if(pointer.revision_id!==args.expected_active_id||pointer.revision_id!==evaluation.baseline_revision_id||Number(pointer.generation)!==evaluation.pointer_generation) throw new Error('Active prompt changed since evaluation. Evaluate again.');
  // Lock route config against simultaneous administrative updates through commit.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-route:${revision.stage}`}))`);
  const routeRows=await tx.execute(sql`select * from routing_config where stage=${revision.stage}`);
  const lockedConfig=routeRows[0] as RouteConfig | undefined ?? configuredRoute;
  if(routeIdentity(await resolveRoute(revision.stage,lockedConfig))!==evaluation.route_hash) throw new Error('Routing changed since evaluation.');
  if(revision.parent_revision!==(pointer.revision_id??'v1.0-baseline')) throw new Error('Candidate was generated from a stale baseline.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-module:${revision.stage}`}))`);
  const moduleRows=await tx.execute(sql`select module_id from stage_modules where stage=${revision.stage}`);
  if((moduleRows[0]?.module_id??module.manifest.id)!==evaluation.module_id) throw new Error('Stage implementation changed since evaluation.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-evaluation:${revision.id}`}))`);
  const latest=await tx.execute(sql`select id from prompt_revision_evaluations where workspace_id=${workspace_id} and revision_id=${revision.id} order by created_at desc,id desc limit 1`);
  if(latest[0]?.id!==evaluation.id) throw new Error('A newer evaluation exists. Review the latest evaluation.');
  const generation=Number(pointer.generation)+1;
  await tx.execute(sql`update prompt_active_revisions set revision_id=${revision.id}, generation=${generation} where workspace_id=${workspace_id} and stage=${revision.stage}`);
  if(pointer.revision_id) await tx.execute(sql`update prompt_revisions set state='superseded' where id=${pointer.revision_id}`);
  await tx.execute(sql`update prompt_revisions set state='active' where id=${revision.id}`);
  await tx.execute(sql`insert into prompt_revision_history(id,workspace_id,stage,before_id,after_id,evaluation_id,actor,action,created_at,generation) values(${newId('prh')},${workspace_id},${revision.stage},${pointer.revision_id},${revision.id},${evaluation.id},${JSON.stringify(args.actor)}::jsonb,'approve',${nowIso()},${generation})`);
 });
 return {...revision,state:'active'};
}
/** Restore the revision that preceded the current approval; baseline is represented by null. */
export async function rollbackPromptRevision(args:{stage:StageId;expected_active_id:string;actor:Actor}):Promise<PromptRevision|null> {
 const workspace_id=await scopedWorkspaceId();if(!workspace_id) throw new Error('An authorised workspace is required.');
 await ensurePlatformSchema();
 let previous:string|null=null;
 await sharedDb().transaction(async tx=>{
  const rows=await tx.execute(sql`select * from prompt_active_revisions where workspace_id=${workspace_id} and stage=${args.stage} for update`);const pointer=rows[0];
  if(!pointer||pointer.revision_id!==args.expected_active_id) throw new Error('Active prompt changed. Reload before rollback.');
  const history=await tx.execute(sql`select before_id from prompt_revision_history where workspace_id=${workspace_id} and stage=${args.stage} and after_id=${args.expected_active_id} and action='approve' order by generation desc limit 1`);
  if(!history[0]) throw new Error('No prior approved prompt exists.');previous=history[0].before_id as string|null;
  const generation=Number(pointer.generation)+1;
  await tx.execute(sql`update prompt_active_revisions set revision_id=${previous},generation=${generation} where workspace_id=${workspace_id} and stage=${args.stage}`);
  await tx.execute(sql`update prompt_revisions set state='superseded' where id=${args.expected_active_id}`);
  if(previous) await tx.execute(sql`update prompt_revisions set state='active' where id=${previous}`);
  await tx.execute(sql`insert into prompt_revision_history(id,workspace_id,stage,before_id,after_id,actor,action,created_at,generation) values(${newId('prh')},${workspace_id},${args.stage},${args.expected_active_id},${previous},${JSON.stringify(args.actor)}::jsonb,'rollback',${nowIso()},${generation})`);
 });
 return previous?getPromptRevision(previous,workspace_id):null;
}
