import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
/** Immutable prompt candidates generated from revalidated lessons and frozen, lineage-separated evidence. */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor, StageId, EvalCase } from "./contracts";
import { listDecisionExamples, scrubLesson, workspaceEntityNames, type DecisionExample } from "./decision-examples";
import { ensurePlatformSchema, sharedDb } from "./db";
import * as tables from "./schema";
import { newId, nowIso } from "./ids";
import { recordAudit } from "./audit";
import { assertAiEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";
import { isTestStub } from "./llm";
import { completionFor, routeConfigs, type RouteConfig } from "./routing";
import { RunRecorder, openRun, closeRun } from "./observability";
import { DEFAULT_SCHEMA, DEFAULT_WORKSPACE_ID, runInWorkspace, scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";

import { evidenceHash, frozenReplayCase, type FrozenReplayCase } from "./decision-replay";
import { approvedEvaluationRoute } from "./approved-evaluation-route";
import { activeModule } from "./registry";
import {
  lineageResolver,
  identityKeys,
  lineageGroups,
  reservedTarget,
  routeIdentity,
  REVISION_PROTOCOL,
  TARGET_STAGES,
  targetMetrics,
  type ReservedTarget,
} from "./revision-policy";
import { assertEvaluationRoute } from "./evaluation-isolation";
import type { ResolvedRoute } from "./contracts";

export const REVISION_STAGES = ["S2", "S3", "S4", "S6", "S8", "S9"] as const;
export type PromptRevisionState = "candidate" | "evaluated" | "active" | "superseded";
export type PromptRevision = {
  id: string;
  workspace_id: string;
  stage: StageId;
  parent_revision: string;
  instruction_text: string;
  creator: Actor;
  created_at: string;
  state: PromptRevisionState;
  cohort_id: string;
  training_ids: string[];
  heldout_ids: string[];
  excluded_ids: string[];
  generation_run_id: string;
  model: string | null;
  provider_id: string | null;
};
/** Exact cases and context reserved before generation; null marks legacy cohorts. */
export type GoldReservation = {
  version: 1 | 2;
  policy?: typeof REVISION_PROTOCOL;
  targets?: ReservedTarget[];
  route_hash?: string;
  parent_revision?: string;
  pointer_generation?: number;
  cases: { testCase: EvalCase<unknown>; snapshot: FrozenReplayCase }[];
  excluded_ids: string[];
  subject_ids: string[];
  run_ids: string[];
  reason: string | null;
};
export type RevisionCohort = {
  id: string;
  workspace_id: string;
  stage: StageId;
  created_at: string;
  training_ids: string[];
  heldout_ids: string[];
  excluded_ids: string[];
  examples: DecisionExample[];
  replay_exclusions: Record<string, string>;
  gold_reservation: GoldReservation | null;
};
type CohortArgs = { stage: StageId; workspace_id: string; exclude_ids: string[] };

type ApprovedContext = {
  route: ResolvedRoute;
  module_id: string;
  module_version: string;
  parent: string;
  generation: number;
};

type PreviousRoles = { training: Set<string>; heldout: Set<string> };

async function previousRoles(workspace: string, stage: StageId): Promise<PreviousRoles> {
  const rows = await sharedDb()
    .select({
      examples: tables.promptRevisionCohorts.examples,
      training: tables.promptRevisionCohorts.training_ids,
      heldout: tables.promptRevisionCohorts.excluded_ids,
    })
    .from(tables.promptRevisionCohorts)
    .where(and(eq(tables.promptRevisionCohorts.workspace_id, workspace), eq(tables.promptRevisionCohorts.stage, stage)));
  const roles: PreviousRoles = { training: new Set(), heldout: new Set() };
  for (const row of rows) {
    const resolve=lineageResolver(row.examples as DecisionExample[]);
    for (const role of ["training", "heldout"] as const) {
      const ids = new Set(row[role] as string[]);
      for (const example of row.examples as DecisionExample[])
        if (ids.has(example.id)) {
          for (const key of resolve(example) ?? identityKeys(example)) roles[role].add(key);
        }
    }
  }
  return roles;
}

export function selectRevisionCohort(
  args: CohortArgs,
  rows: DecisionExample[],
  approved: ApprovedContext,
  previous?: PreviousRoles,
): RevisionCohort {
  const examples = rows.filter((row) => row.workspace_id === args.workspace_id && row.stage === args.stage);
  const resolve=lineageResolver(examples);
  const groups = lineageGroups(examples);
  const eligible = (example: DecisionExample) => {
    const snapshot = frozenReplayCase(example);
    return (
      snapshot &&
      resolve(example) &&
      snapshot.module_id === approved.module_id &&
      snapshot.module_version === approved.module_version &&
      snapshot.prompt_version === approved.parent &&
      snapshot.route.stage === approved.route.stage &&
      routeIdentity(snapshot.route) === routeIdentity(approved.route) &&
      example.prompt_version === snapshot.prompt_version &&
      example.model === snapshot.route.model &&
      example.provider_id === snapshot.route.provider_id &&
      targetMetrics(example).length > 0
    );
  };
  const explicit = new Set(args.exclude_ids);
  const previouslyUsed = (group: DecisionExample[], role: keyof PreviousRoles) =>
    previous &&
    group.some((row) => [...(resolve(row) ?? identityKeys(row))].some((key) => previous[role].has(key)));
  const units = groups
    .filter(
      (group) =>
        !previouslyUsed(group, "training") &&
        !previouslyUsed(group, "heldout") &&
        !group.some((row) => explicit.has(row.id)),
    )
    .map((group) => group.find(eligible))
    .filter((example): example is DecisionExample => !!example)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const held = units.slice(0, Math.max(REVISION_PROTOCOL.minimum_cases, Math.ceil(units.length / 5)));
  if (held.length < REVISION_PROTOCOL.minimum_cases)
    throw new TrustedApplicationError(
      "Collect at least three independent, attributed human corrections on separate originating runs with the current prompt, stage implementation and primary model settings.",
    );
  const heldIds = new Set(held.map((row) => row.id));
  const excluded = new Set(explicit);
  for (const group of groups)
    if (previouslyUsed(group, "heldout") || group.some((row) => heldIds.has(row.id) || explicit.has(row.id))) {
      for (const row of group) excluded.add(row.id);
    }
  // Preserve all eligible alternatives until the lesson scrubber and reviewer deduplication run.
  const train = groups
    .filter((group) => group.every((row) => !excluded.has(row.id)))
    .flatMap((group) => group.filter((row) => eligible(row) && row.lesson_status === "ok" && row.lesson));
  const keys = new Set(held.flatMap((row) => [...resolve(row)!]));
  const gold: GoldReservation = {
    version: 2,
    policy: REVISION_PROTOCOL,
    route_hash: routeIdentity(approved.route),
    parent_revision: approved.parent,
    pointer_generation: approved.generation,
    targets: [],
    cases: [],
    excluded_ids: [...excluded].sort(),
    subject_ids: [...keys]
      .filter((key) => key.startsWith("id:"))
      .map((key) => key.slice(3))
      .sort(),
    run_ids: [...keys]
      .filter((key) => key.startsWith("run:"))
      .map((key) => key.slice(4))
      .sort(),
    reason: null,
  };
  for (const example of held) {
    const snapshot = { ...structuredClone(frozenReplayCase(example)!), examples: [] };
    gold.targets!.push(reservedTarget(example, snapshot));
    gold.cases.push({ testCase: { name: example.id, input: snapshot.input }, snapshot });
  }
  return {
    id: newId("prc"),
    workspace_id: args.workspace_id,
    stage: args.stage,
    created_at: nowIso(),
    training_ids: train.map((row) => row.id),
    heldout_ids: [...heldIds],
    excluded_ids: gold.excluded_ids,
    examples,
    replay_exclusions: {},
    gold_reservation: gold,
  };
}

/** Build the exact reservation committed by hash to the durable pre-generation run. */
async function freezeRevisionCohort(args: CohortArgs, context: ApprovedContext): Promise<RevisionCohort> {
  assertEvaluationRoute(context.route);
  const examples = await listDecisionExamples({ stage: args.stage, workspace_id: args.workspace_id, limit: null });
  return selectRevisionCohort(args, examples, context, await previousRoles(args.workspace_id, args.stage));
}

/** Retrieve persisted same-workspace frozen evidence for candidate evaluation. */
export async function getRevisionCohort(id: string, workspace_id: string): Promise<RevisionCohort | null> {
  await ensurePlatformSchema();
  const [row] = await sharedDb()
    .select()
    .from(tables.promptRevisionCohorts)
    .where(and(eq(tables.promptRevisionCohorts.id, id), eq(tables.promptRevisionCohorts.workspace_id, workspace_id)));
  return row ? (row as RevisionCohort) : null;
}

/** Generate another version; no generation outcome changes a live prompt pointer. */
export async function proposePromptRevision(args: CohortArgs & { actor: Actor }): Promise<PromptRevision> {
  if (!TARGET_STAGES.some((stage) => stage === args.stage))
    throw new TrustedApplicationError(
      "This stage has no independent human target contract. Collect structured, attributable corrections before generating a candidate.",
    );
  const workspace = await getWorkspace(args.workspace_id);
  if (!workspace && args.workspace_id !== DEFAULT_WORKSPACE_ID)
    throw new TrustedApplicationError("Learning workspace is unavailable.");
  return runInWorkspace({ workspace_id: args.workspace_id, schema: workspace?.schema_name ?? DEFAULT_SCHEMA }, async () => {
    await assertAiEnabled("Prompt revision generation", sectionOfStage(args.stage) ?? undefined);
    const pointer = await activeRevisionPointer(args.workspace_id, args.stage);
    const parent = pointer.revision_id ?? "v1.0-baseline";
    const active = pointer.revision_id ? await getPromptRevision(pointer.revision_id, args.workspace_id) : null;
    const route = await approvedEvaluationRoute(args.stage);
    assertEvaluationRoute(route);
    const stageModule = await activeModule(args.stage);
    const history = await sharedDb()
      .select({ id: tables.promptRevisions.id, stage: tables.promptRevisions.stage })
      .from(tables.promptRevisions)
      .where(eq(tables.promptRevisions.workspace_id, args.workspace_id));
    const previousCandidates = history
      .filter((row) => row.stage === args.stage)
      .map((row) => row.id)
      .sort();
    const cohort = await freezeRevisionCohort(args, {
      route,
      module_id: stageModule.manifest.id,
      module_version: stageModule.manifest.version,
      parent,
      generation: pointer.generation,
    });
    const entities = await workspaceEntityNames();
    if (!entities.length) throw new TrustedApplicationError("Learning entity context is empty.");
    const training = new Set(cohort.training_ids);
    const lessons: { id: string; lesson: string }[] = [];
    const reviewers = new Set<string>(),
      texts = new Set<string>();
    for (const group of lineageGroups(cohort.examples)) {
      for (const example of group) {
        const reviewer = example.actor_principal?.trim().toLowerCase();
        if (!training.has(example.id) || !reviewer || reviewers.has(reviewer) || !example.lesson) continue;
        const lesson = scrubLesson(
          example.lesson,
          [
            JSON.stringify(example.ai_input),
            JSON.stringify(example.ai_output),
            JSON.stringify(example.final ?? {}),
            example.rationale ?? "",
          ],
          entities,
        );
        const text = lesson?.trim().toLowerCase();
        if (!lesson || !text || texts.has(text)) continue;
        lessons.push({ id: example.id, lesson });
        reviewers.add(reviewer);
        texts.add(text);
        break;
      }
    }
    if (reviewers.size < REVISION_PROTOCOL.minimum_reviewers)
      throw new TrustedApplicationError(
        "Collect distinct validated disagreement lessons from at least two identified reviewers on independent training cases outside the holdout.",
      );
    cohort.training_ids = lessons.map((item) => item.id);
    if (isTestStub()) throw new TrustedApplicationError("Use a connected primary model to generate a production candidate.");
    const recorder = new RunRecorder({
      workspace_id: args.workspace_id,
      stage: args.stage,
      module_id: "learning.prompt-revision",
      module_version: "1.0.0",
      actor: args.actor,
      input: {
        cohort_id: cohort.id,
        parent_revision: parent,
        lesson_count: lessons.length,
        route_hash: routeIdentity(route),
        module_id: stageModule.manifest.id,
        module_version: stageModule.manifest.version,
        reservation_hash: evidenceHash(cohort.gold_reservation),
        targets: cohort.gold_reservation!.targets,
      },
    });
    await openRun(recorder);
    try {
      // No raw answers, customer metadata, example IDs, or held-out lessons enter the completion.
      const response = await completionFor(
        route,
        recorder,
      )({
        system:
          'Draft concise additional instructions for an evidence-planning stage using only general reviewer lessons. Preserve human decisions and require source-grounded evidence. Return JSON only: {"instruction_text":""}.',
        user: JSON.stringify({ stage: args.stage, lessons: lessons.map((item) => item.lesson) }),
        purpose: "prompt-revision",
      });
      const parsed = z
        .object({ instruction_text: z.string().trim().min(1).max(8000) })
        .strict()
        .parse(response);
      if (parsed.instruction_text.trim() === (active?.instruction_text ?? "").trim())
        throw new TrustedApplicationError("The candidate repeats the approved instruction. Review the training lessons.");
      const revision: PromptRevision = {
        id: newId("prv"),
        workspace_id: args.workspace_id,
        stage: args.stage,
        parent_revision: parent,
        instruction_text: parsed.instruction_text,
        creator: args.actor,
        created_at: nowIso(),
        state: "candidate",
        cohort_id: cohort.id,
        training_ids: lessons.map((item) => item.id),
        heldout_ids: cohort.heldout_ids,
        excluded_ids: cohort.excluded_ids,
        generation_run_id: recorder.id,
        model: route?.model ?? null,
        provider_id: route?.provider_id ?? null,
      };
      await sharedDb().transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${"prompt-cohort:" + args.workspace_id + ":" + args.stage}))`,
        );
        const current = await tx
          .select({ id: tables.promptRevisions.id })
          .from(tables.promptRevisions)
          .where(
            and(eq(tables.promptRevisions.workspace_id, args.workspace_id), eq(tables.promptRevisions.stage, args.stage)),
          );
        if (evidenceHash(current.map((row) => row.id).sort()) !== evidenceHash(previousCandidates))
          throw new TrustedApplicationError(
            "Another candidate reserved evidence during generation. Generate again using fresh cases.",
          );
        await tx.insert(tables.promptRevisionCohorts).values(cohort);
        await tx.insert(tables.promptRevisions).values(revision);
        await recordAudit(
          {
            category: "config",
            action: "prompt.generate",
            entity_type: "prompt_revision",
            entity_id: revision.id,
            workspace_id: args.workspace_id,
            after: {
              stage: revision.stage,
              parent_revision: parent,
              state: revision.state,
              instruction_text: revision.instruction_text,
            },
            run_id: recorder.id,
            meta: { training_count: revision.training_ids.length, heldout_count: revision.heldout_ids.length },
          },
          { tx },
        );
      });
      await closeRun({
        recorder,
        status: "ok",
        route: route ?? undefined,
        output: { revision_id: revision.id, state: revision.state },
      });
      return revision;
    } catch (error) {
      await closeRun({
        recorder,
        status: "error",
        route: route ?? undefined,
        output: {},
        error: error instanceof Error ? error.message : String(error),
      });
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
 if(!workspace_id) throw new TrustedApplicationError('An authorised workspace is required.');
 const revision=await getPromptRevision(args.revision_id,workspace_id);
 if(!revision) throw new TrustedApplicationError('Unknown candidate in this workspace.');
 const {getRevisionEvaluation,promotionEligibility,validateReservedCohort,verifyGenerationReservation}=await import('./prompt-revision-evals');
 const evaluation=await getRevisionEvaluation(args.evaluation_id,workspace_id);
 if(!evaluation||evaluation.revision_id!==revision.id||!promotionEligibility(evaluation).eligible) throw new TrustedApplicationError('Evaluation is missing or ineligible.');
 const cohort=await getRevisionCohort(revision.cohort_id,workspace_id);
 if(!cohort || revision.stage!==evaluation.stage || evaluation.cohort_id!==cohort.id || evaluation.workspace_id!==workspace_id ||
    evaluation.case_hash!==evidenceHash(cohort.gold_reservation) || evidenceHash(evaluation.targets)!==evidenceHash(cohort.gold_reservation?.targets ?? []) ||
    evidenceHash(evaluation.gold_cases)!==evidenceHash(cohort.gold_reservation?.cases ?? [])) throw new TrustedApplicationError('Frozen cohort or target lineage changed. Generate a new candidate.');
 validateReservedCohort(cohort);
 await verifyGenerationReservation(revision,cohort);
 const configuredRoute=(await routeConfigs({preserveStored:true})).find(row=>row.stage===revision.stage);
 const route=await approvedEvaluationRoute(revision.stage,configuredRoute);
 assertEvaluationRoute(route);
 if(routeIdentity(route)!==evaluation.route_hash) throw new TrustedApplicationError('Routing changed since evaluation. Evaluate again.');
 const stageModule=await activeModule(revision.stage);
 if(stageModule.manifest.id!==evaluation.module_id||stageModule.manifest.version!==evaluation.module_version) throw new TrustedApplicationError('Stage implementation changed since evaluation.');
 await sharedDb().transaction(async tx=>{
  await tx.execute(sql`insert into prompt_active_revisions(workspace_id,stage) values(${workspace_id},${revision.stage}) on conflict do nothing`);
  const rows=await tx.execute(sql`select * from prompt_active_revisions where workspace_id=${workspace_id} and stage=${revision.stage} for update`);
  const pointer=rows[0];
  if(pointer.revision_id!==args.expected_active_id||pointer.revision_id!==evaluation.baseline_revision_id||Number(pointer.generation)!==evaluation.pointer_generation) throw new TrustedApplicationError('Active prompt changed since evaluation. Evaluate again.');
  // Lock route config against simultaneous administrative updates through commit.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-route:${revision.stage}`}))`);
  const routeRows=await tx.execute(sql`select * from routing_config where stage=${revision.stage}`);
  const lockedConfig=routeRows[0] as RouteConfig | undefined;
  const currentConfig=lockedConfig ?? configuredRoute;
  if(!currentConfig || routeIdentity({...route, provider_id:currentConfig.provider_id, model:currentConfig.model,
      params:currentConfig.params, fallbacks:currentConfig.fallbacks})!==evaluation.route_hash) throw new TrustedApplicationError('Routing changed since evaluation.');
  if(revision.parent_revision!==(pointer.revision_id??'v1.0-baseline')) throw new TrustedApplicationError('Candidate was generated from a stale baseline.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-module:${revision.stage}`}))`);
  const moduleRows=await tx.execute(sql`select module_id from stage_modules where stage=${revision.stage}`);
  if((moduleRows[0]?.module_id??stageModule.manifest.id)!==evaluation.module_id) throw new TrustedApplicationError('Stage implementation changed since evaluation.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-evaluation:${revision.id}`}))`);
  const binding=await tx.execute(sql`select bound_id from prompt_revision_attempts where workspace_id=${workspace_id} and revision_id=${revision.id} for update`);
  if(binding[0]?.bound_id!==evaluation.id) throw new TrustedApplicationError("Only the original completed evaluation can approve this candidate.");
  const generation=Number(pointer.generation)+1;
  await tx.execute(sql`update prompt_active_revisions set revision_id=${revision.id}, generation=${generation} where workspace_id=${workspace_id} and stage=${revision.stage}`);
  if(pointer.revision_id) await tx.execute(sql`update prompt_revisions set state='superseded' where id=${pointer.revision_id}`);
  await tx.execute(sql`update prompt_revisions set state='active' where id=${revision.id}`);
  await tx.execute(sql`insert into prompt_revision_history(id,workspace_id,stage,before_id,after_id,evaluation_id,actor,action,created_at,generation) values(${newId('prh')},${workspace_id},${revision.stage},${pointer.revision_id},${revision.id},${evaluation.id},${JSON.stringify(args.actor)}::jsonb,'approve',${nowIso()},${generation})`);
  // KAN-89: the platform audit record commits with the pointer change.
  await recordAudit({category:'config',action:'prompt.approve',entity_type:'prompt_revision',entity_id:revision.id,workspace_id,
   before:{stage:revision.stage,active_revision:pointer.revision_id??null,generation:Number(pointer.generation)},
   after:{stage:revision.stage,active_revision:revision.id,generation},meta:{evaluation_id:evaluation.id}},{tx});
 });
 return {...revision,state:'active'};
}
/** Restore the revision that preceded the current approval; baseline is represented by null. */
export async function rollbackPromptRevision(args:{stage:StageId;expected_active_id:string;actor:Actor}):Promise<PromptRevision|null> {
 const workspace_id=await scopedWorkspaceId();if(!workspace_id) throw new TrustedApplicationError('An authorised workspace is required.');
 await ensurePlatformSchema();
 let previous:string|null=null;
 await sharedDb().transaction(async tx=>{
  const rows=await tx.execute(sql`select * from prompt_active_revisions where workspace_id=${workspace_id} and stage=${args.stage} for update`);const pointer=rows[0];
  if(!pointer||pointer.revision_id!==args.expected_active_id) throw new TrustedApplicationError('Active prompt changed. Reload before rollback.');
  const history=await tx.execute(sql`select before_id from prompt_revision_history where workspace_id=${workspace_id} and stage=${args.stage} and after_id=${args.expected_active_id} and action='approve' order by generation desc limit 1`);
  if(!history[0]) throw new TrustedApplicationError('No prior approved prompt exists.');previous=history[0].before_id as string|null;
  const generation=Number(pointer.generation)+1;
  await tx.execute(sql`update prompt_active_revisions set revision_id=${previous},generation=${generation} where workspace_id=${workspace_id} and stage=${args.stage}`);
  await tx.execute(sql`update prompt_revisions set state='superseded' where id=${args.expected_active_id}`);
  if(previous) await tx.execute(sql`update prompt_revisions set state='active' where id=${previous}`);
  await tx.execute(sql`insert into prompt_revision_history(id,workspace_id,stage,before_id,after_id,actor,action,created_at,generation) values(${newId('prh')},${workspace_id},${args.stage},${args.expected_active_id},${previous},${JSON.stringify(args.actor)}::jsonb,'rollback',${nowIso()},${generation})`);
  await recordAudit({category:'config',action:'prompt.rollback',entity_type:'prompt_revision',entity_id:args.expected_active_id,workspace_id,
   before:{stage:args.stage,active_revision:args.expected_active_id,generation:Number(pointer.generation)},
   after:{stage:args.stage,active_revision:previous,generation}},{tx});
 });
 return previous?getPromptRevision(previous,workspace_id):null;
}
