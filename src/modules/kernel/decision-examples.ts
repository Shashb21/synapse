import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { DEFAULT_SCHEMA, DEFAULT_WORKSPACE_ID, runInWorkspace, scopedWorkspaceId } from "@/modules/workspaces/context";
import type { Actor, JsonCompletion, StageId } from "./contracts";
import { sharedDb } from "./db";
import { newId, nowIso } from "./ids";
import { isTestStub } from "./llm";
import { canPrompt, completionFor, resolveRoute } from "./routing";
import { closeRun, getRun, openRun, RunRecorder } from "./observability";
import { aiSectionEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";

/**
 * Learning from decisions (KAN-77). Every time a person accepts, edits or rejects
 * something the AI proposed, the case is kept as an example. Later runs see a few
 * similar past cases as worked examples instead of standing rules (KAN-79).
 *
 * Learning is global, but raw customer text never crosses workspaces: a case is
 * shown verbatim only inside its own workspace. Elsewhere only its de-identified
 * lesson is used, and only once the scrubber has passed it.
 */

export type DecisionKind = "gap_suggestion" | "s9_proposal" | "s4_mapping" | "s8_band" | "residual_split";
export type DecisionOutcome = "accepted" | "edited" | "rejected";
export type LessonStatus = "pending" | "ok" | "failed";

export type DecisionExample = {
  id: string;
  workspace_id: string;
  stage: StageId;
  kind: DecisionKind;
  subject_id: string;
  /** What the AI saw, compactly: the item's name and statement, the gap it was judged against. */
  ai_input: Record<string, unknown>;
  /** What the AI proposed: its verdict, band, wording. */
  ai_output: Record<string, unknown>;
  outcome: DecisionOutcome;
  /** The person's final values, when they differ from the AI's. */
  final: Record<string, unknown> | null;
  rationale: string | null;
  lesson: string | null;
  lesson_status: LessonStatus;
  model: string | null;
  provider_id: string | null;
  created_at: string;
  run_id?: string | null;
  prompt_version?: string | null;
  actor?: Actor | null;
  replay_input?: Record<string, unknown> | null;
  replay_exclusion_reason?: string | null;
};

export type DecisionExampleDraft = {
  stage: StageId;
  kind: DecisionKind;
  subject_id: string;
  ai_input: Record<string, unknown>;
  ai_output: Record<string, unknown>;
  outcome: DecisionOutcome;
  final?: Record<string, unknown> | null;
  rationale?: string | null;
  workspace_id?: string;
  run_id?: string | null;
  prompt_version?: string | null;
  actor?: Actor | null;
  replay_input?: Record<string, unknown> | null;
  replay_exclusion_reason?: string | null;
  /** Stable human-decision identity, shared by nested capture paths. */
  capture_key?: string;
  /** AI-only capture paths must prove their recorded run exists in this workspace. */
  require_originating_run?: boolean;
};

export const DECISION_EXAMPLES_DDL = `CREATE TABLE IF NOT EXISTS decision_examples (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  stage text NOT NULL,
  kind text NOT NULL,
  subject_id text NOT NULL,
  ai_input jsonb NOT NULL,
  ai_output jsonb NOT NULL,
  outcome text NOT NULL,
  final jsonb,
  rationale text,
  lesson text,
  lesson_status text NOT NULL DEFAULT 'pending',
  model text,
  provider_id text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_examples_stage_kind ON decision_examples(stage, kind);
ALTER TABLE decision_examples ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE decision_examples ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE decision_examples ADD COLUMN IF NOT EXISTS actor jsonb;
ALTER TABLE decision_examples ADD COLUMN IF NOT EXISTS replay_input jsonb;
ALTER TABLE decision_examples ADD COLUMN IF NOT EXISTS replay_exclusion_reason text;
ALTER TABLE decision_examples ADD COLUMN IF NOT EXISTS capture_key text;
CREATE UNIQUE INDEX IF NOT EXISTS decision_examples_capture_key ON decision_examples(workspace_id, capture_key)`;

let tableReady: Promise<unknown> | null = null;
/** One copy for every workspace: it lives in the public schema, like platform settings. */
async function ensureTable() {
  tableReady ??= (async () => {
    for (const stmt of DECISION_EXAMPLES_DDL.split(";").map((part) => part.trim()).filter(Boolean)) {
      await sharedDb().execute(sql.raw(stmt));
    }
  })().catch((error) => {
    tableReady = null; // retry on the next call
    throw error;
  });
  await tableReady;
}

type Row = Omit<DecisionExample, "ai_input" | "ai_output" | "final"> & {
  ai_input: unknown;
  ai_output: unknown;
  final: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function toExample(row: Row): DecisionExample {
  return {
    ...row,
    ai_input: asRecord(row.ai_input),
    ai_output: asRecord(row.ai_output),
    final: row.final == null ? null : asRecord(row.final),
    replay_input: row.replay_input == null ? null : asRecord(row.replay_input),
    replay_exclusion_reason: row.replay_exclusion_reason ?? (row.replay_input == null ? "No frozen originating stage input is available." : null),
  };
}

/**
 * Keeps one decision as an example. Best-effort by design: a logging failure is
 * reported and swallowed, never failing the person's action. The lesson is worked
 * out afterwards, off the request.
 */
export async function recordDecisionExample(draft: DecisionExampleDraft): Promise<string | null> {
  try {
    await ensureTable();
    const workspace_id = draft.workspace_id ?? (await scopedWorkspaceId()) ?? "default";
    const run = draft.run_id ? await originatingRun(workspace_id, draft.run_id, draft.stage) : null;
    if (draft.require_originating_run && (!run || run.status !== "ok")) {
      console.warn("[learning] decision omitted: originating AI run unavailable", draft.kind, draft.subject_id);
      return null;
    }
    const route = run?.route;
    const promptVersion = draft.prompt_version ?? (run?.steps.find(step => step.name === "prompt:variant")?.data as { version?: string } | undefined)?.version ?? null;
    const replay = draft.replay_input ?? null;
    const captureKey = draft.capture_key ?? null;
    const id = newId("dex");
    const inserted = await sharedDb().execute(sql`
      insert into decision_examples
        (id, workspace_id, stage, kind, subject_id, ai_input, ai_output, outcome, final, rationale,
         lesson, lesson_status, model, provider_id, created_at, run_id, prompt_version, actor, replay_input, replay_exclusion_reason, capture_key)
      values
        (${id}, ${workspace_id}, ${draft.stage}, ${draft.kind}, ${draft.subject_id},
         ${JSON.stringify(draft.ai_input)}::jsonb, ${JSON.stringify(draft.ai_output)}::jsonb,
         ${draft.outcome}, ${draft.final == null ? null : JSON.stringify(draft.final)}::jsonb,
         ${draft.rationale?.trim() || null}, null, 'pending', ${route?.model ?? null},
         ${route?.provider_id ?? null}, ${nowIso()}, ${draft.run_id ?? null}, ${promptVersion},
         ${JSON.stringify(draft.actor ?? null)}::jsonb, ${replay == null ? null : JSON.stringify(replay)}::jsonb,
         ${draft.replay_exclusion_reason ?? (replay ? null : "No frozen originating stage input is available.")}, ${captureKey})
      on conflict (workspace_id, capture_key) do nothing
      returning id
    `);
    if ((inserted as unknown as { id: string }[]).length === 0) return null;
    // Off the request: the person's action does not wait for the lesson.
    void computeLesson(id).catch((error) => console.error("[learning] lesson failed", id, error));
    return id;
  } catch (error) {
    console.error("[learning] could not record a decision example", draft.kind, draft.subject_id, error);
    return null;
  }
}

export async function getDecisionExample(id: string): Promise<DecisionExample | null> {
  await ensureTable();
  const rows = (await sharedDb().execute(
    sql`select * from decision_examples where id = ${id} limit 1`,
  )) as unknown as Row[];
  return rows[0] ? toExample(rows[0]) : null;
}

export async function listDecisionExamples(args: {
  stage?: StageId;
  kinds?: DecisionKind[];
  limit?: number;
}): Promise<DecisionExample[]> {
  await ensureTable();
  const limit = args.limit ?? 500;
  const rows = (await sharedDb().execute(
    args.stage
      ? sql`select * from decision_examples where stage = ${args.stage} order by created_at desc limit ${limit}`
      : sql`select * from decision_examples order by created_at desc limit ${limit}`,
  )) as unknown as Row[];
  const kinds = args.kinds?.length ? new Set<string>(args.kinds) : null;
  return rows.map(toExample).filter((example) => !kinds || kinds.has(example.kind));
}

async function setLesson(id: string, lesson: string | null, status: LessonStatus) {
  await sharedDb().execute(
    sql`update decision_examples set lesson = ${lesson}, lesson_status = ${status} where id = ${id}`,
  );
}

// ---------------------------------------------------------------------------
// De-identified lessons

export const LESSON_SYSTEM = `You turn one reviewer decision about an evidence plan into a general lesson another team could learn from.
Write one or two plain sentences about the kind of case and what the reviewer decided, and why in general terms.
Never include: product, brand or drug names (including generic/INN names), company, person, site or study names, numbers, dates, countries' specific programmes, or quotes.
Describe the case by type instead (for example "a narrower patient population", "a specific comparator", "an existing management gap").
Return JSON only: {"lesson":""}`;

export function lessonPrompt(example: DecisionExample): string {
  return JSON.stringify({
    stage: example.stage,
    kind: example.kind,
    ai_saw: example.ai_input,
    ai_proposed: example.ai_output,
    reviewer_outcome: example.outcome,
    reviewer_final: example.final,
    reviewer_reason: example.rationale,
  });
}

/**
 * Words a lesson may use even when the case wrote them with a capital: common
 * English and generic evidence-planning vocabulary. Anything else the case
 * capitalised is treated as a possible name (KAN-78).
 */
const GENERIC = new Set(
  [
    "the", "a", "an", "and", "or", "but", "when", "if", "for", "in", "on", "of", "to", "with", "by", "as", "at", "from",
    "is", "are", "was", "be", "it", "this", "that", "these", "those", "they", "no", "not", "none", "all", "any", "each",
    "reviewers", "reviewer", "gap", "gaps", "tactic", "tactics", "source", "sources", "new", "existing", "plan",
    "real", "real-world", "patient", "patients", "population", "populations", "missing", "lack", "data", "evidence",
    "management", "long-term", "quality", "life", "comparative", "effectiveness", "safety", "efficacy", "outcomes",
    "study", "studies", "trial", "trials", "registry", "survey", "analysis", "review", "model", "cost", "costs",
    "keep", "kept", "separate", "merge", "merged", "split", "reject", "rejected", "accept", "accepted", "edited",
    "hta", "rwe", "pro", "pros", "qol", "os", "pfs", "orr", "dor", "tot", "eu", "uk", "us", "nice", "ema", "fda",
    "kol", "kols", "hcp", "hcps", "cea", "itc", "maic", "nma", "slr", "iis", "ae", "aes", "phase", "i", "ii", "iii",
    "iv", "payer", "payers", "medical", "affairs", "heor", "g-ba", "has", "aifa", "aemps", "overlaps", "same",
  ].map((word) => word.toLowerCase()),
);

/** Drug-name endings (INN stems) a lesson must never contain, whatever the workspace calls its asset. */
const INN_STEM = /\b[a-z]{3,}(?:mab|nib|tinib|ciclib|parib|lisib|rafenib|zumab|ximab|tide|stat|vir|lukast)\b/i;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? [];
}

/**
 * Names the raw case might give away: any word it wrote with a capital (names
 * often open a field, so position is no guide), codes with digits, and the
 * workspace's own entity names. Conservative on purpose: a lesson shown to other
 * customers should not carry product-specific detail. Pure and deterministic.
 */
export function riskyTerms(rawTexts: string[], entityNames: string[]): { words: Set<string>; phrases: string[] } {
  const words = new Set<string>();
  for (const text of rawTexts) {
    for (const match of text.matchAll(/\b[A-Z][\w-]{1,}/g)) {
      const word = match[0].toLowerCase();
      if (!GENERIC.has(word)) words.add(word);
      // "ZEPHYR-RWE" is one name; its parts are names too.
      for (const part of word.split("-")) if (part.length >= 3 && !GENERIC.has(part)) words.add(part);
    }
    for (const match of text.matchAll(/\b[A-Za-z]*\d[\w-]*\b/g)) words.add(match[0].toLowerCase());
  }
  const phrases = entityNames.map((name) => name.trim().toLowerCase()).filter((name) => name.length >= 3);
  for (const phrase of phrases) {
    for (const word of wordsOf(phrase)) if (word.length >= 4 && !GENERIC.has(word)) words.add(word);
  }
  return { words, phrases };
}

/**
 * The deterministic backstop after the model writes a lesson. Returns the lesson
 * when it is safe to show another customer, or null when it might identify one.
 */
export function scrubLesson(lesson: string, rawTexts: string[], entityNames: string[]): string | null {
  const text = lesson.replace(/\s+/g, " ").trim();
  if (!text || text.length > 400) return null;
  if (/\d/.test(text)) return null;
  if (/["“”«»„‘’]/.test(text)) return null;
  if (/(?:^|\s)'[^']+'(?:$|[\s.,;:])/.test(text)) return null;
  if (INN_STEM.test(text)) return null;
  const { words, phrases } = riskyTerms(rawTexts, entityNames);
  const lower = text.toLowerCase();
  if (phrases.some((phrase) => lower.includes(phrase))) return null;
  if (wordsOf(text).some((word) => words.has(word))) return null;
  return text;
}

function rawTextsOf(example: DecisionExample): string[] {
  return [JSON.stringify(example.ai_input), JSON.stringify(example.ai_output), JSON.stringify(example.final ?? {}), example.rationale ?? ""];
}

/** Strings under name-like keys anywhere in the planning context (asset, company, competitors…). */
function namedStrings(value: unknown, key = "", out: string[] = []): string[] {
  if (typeof value === "string") {
    if (/name|brand|inn|company|owner|competitor|comparator|lead|sponsor/i.test(key) && value.trim()) out.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) namedStrings(item, key, out);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) namedStrings(child, childKey, out);
  }
  return out;
}

/** The workspace's own names: asset, INN, planning-context names, source titles, tactic names. */
export async function workspaceEntityNames(): Promise<string[]> {
  // Loaded lazily: the store records decisions through this module.
  const { loadState } = await import("@/lib/iegp/store");
  const state = await loadState();
  return [
    state.asset.name,
    state.asset.inn,
    ...namedStrings(state.asset.planning_context),
    ...state.sources.map((source) => source.title),
    ...state.tactics.map((tactic) => tactic.name),
  ].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

/**
 * Asks the model for a general lesson, then scrubs it. Returns the lesson to keep,
 * or null when the model gave none or the scrubber refused it.
 */
export async function deidentifyLesson(
  example: DecisionExample,
  complete: JsonCompletion,
  entityNames: string[],
): Promise<string | null> {
  const payload = (await complete({ system: LESSON_SYSTEM, user: lessonPrompt(example), purpose: "decision-lesson" })) as {
    lesson?: unknown;
  } | null;
  const lesson = typeof payload?.lesson === "string" ? payload.lesson : "";
  return scrubLesson(lesson, rawTextsOf(example), entityNames);
}

/**
 * Works out a pending example's lesson. With AI off for the stage, under the test
 * stub, or with no connected route it stays pending, to be computed later.
 */
export async function computeLesson(id: string, complete?: JsonCompletion): Promise<LessonStatus | null> {
  const example = await getDecisionExample(id);
  if (!example || example.lesson_status === "ok") return example?.lesson_status ?? null;
  try {
    return await inRecordedWorkspace(example.workspace_id, () => computeRecordedLesson(example, complete));
  } catch (error) {
    await setLesson(id, null, "failed");
    console.error("[learning] lesson processing failed", id, error);
    return "failed";
  }
}

/** Keep all context reads and lesson traces inside the example's recorded workspace. */
async function computeRecordedLesson(example: DecisionExample, complete?: JsonCompletion): Promise<LessonStatus> {
  const id = example.id;
  const section = sectionOfStage(example.stage);
  if (!complete) {
    if (isTestStub()) return "pending";
    if (section && !(await aiSectionEnabled(section))) return "pending";
  }
  let entityNames: string[];
  try {
    entityNames = await entitiesForWorkspace(example.workspace_id);
  } catch (error) {
    console.error("[learning] entity context unavailable", id, error);
    await setLesson(id, null, "failed");
    return "failed";
  }
  if (complete) {
    try {
      const lesson = await deidentifyLesson(example, complete, entityNames);
      await setLesson(id, lesson, lesson ? "ok" : "failed");
      return lesson ? "ok" : "failed";
    } catch (error) {
      await setLesson(id, null, "failed");
      console.error("[learning] lesson generation failed", id, error);
      return "failed";
    }
  }
  const route = await inRecordedWorkspace(example.workspace_id, () => resolveRoute(example.stage));
  if (!canPrompt(route)) return "pending";
  const recorder = new RunRecorder({
    workspace_id: example.workspace_id,
    stage: example.stage,
    module_id: "learning.lesson",
    module_version: "1.0.0",
    actor: { name: "Synapse", function: "medical_affairs" },
    input: { example_id: id },
  });
  await openRun(recorder);
  try {
    const lesson = await deidentifyLesson(example, completionFor(route, recorder), entityNames);
    await setLesson(id, lesson, lesson ? "ok" : "failed");
    await closeRun({ recorder, status: "ok", route, output: { lesson_status: lesson ? "ok" : "failed" } });
    return lesson ? "ok" : "failed";
  } catch (error) {
    await setLesson(id, null, "failed");
    await closeRun({ recorder, status: "error", route, output: {}, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Admin: work out pending lessons and retry failures, oldest first. */
export async function computePendingLessons(limit = 50): Promise<{ ok: number; failed: number; pending: number }> {
  await ensureTable();
  const rows = (await sharedDb().execute(
    sql`select id from decision_examples where lesson_status in ('pending', 'failed') order by created_at asc limit ${limit}`,
  )) as unknown as { id: string }[];
  const tally = { ok: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    const status = await computeLesson(row.id).catch(() => "pending" as const);
    if (status) tally[status] += 1;
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Worked examples at run time

export type WorkedExample =
  | {
      id: string;
      scope: "this_plan";
      kind: DecisionKind;
      case: Record<string, unknown>;
      ai_proposed: Record<string, unknown>;
      reviewer: DecisionOutcome;
      reviewer_final: Record<string, unknown> | null;
      reason: string | null;
    }
  | { id: string; scope: "other_plans"; kind: DecisionKind; lesson: string };

function exampleText(example: DecisionExample): string {
  return [JSON.stringify(example.ai_input), JSON.stringify(example.ai_output)].join(" ");
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "is", "are", "no", "not", "data", "evidence"]);

function tokens(text: string): string[] {
  return wordsOf(text).filter((word) => word.length > 2 && !STOP.has(word));
}

/**
 * Ranks examples by how much of the query's vocabulary they share, weighted so
 * rare words count more (a BM25-lite overlap). Deterministic; no embeddings yet.
 */
export function rankBySimilarity<T>(query: string, items: T[], textOf: (item: T) => string): { item: T; score: number }[] {
  const queryTokens = new Set(tokens(query));
  if (queryTokens.size === 0 || items.length === 0) return [];
  const docs = items.map((item) => new Set(tokens(textOf(item))));
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) ?? 0) + 1);
  const n = docs.length;
  return items
    .map((item, index) => {
      let score = 0;
      for (const token of queryTokens) {
        if (!docs[index]!.has(token)) continue;
        score += Math.log(1 + (n - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
      }
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * The few past decisions most like this case. Same-workspace cases may be shown as
 * they were; cases from any other workspace only as their scrubbed lesson.
 */
export async function similarExamples(args: {
  stage: StageId;
  kinds?: DecisionKind[];
  text: string;
  workspace_id: string;
  take?: number;
  exclude_ids?: string[];
  allow_cross_workspace?: boolean;
}): Promise<WorkedExample[]> {
  const take = args.take ?? 4;
  const excluded = new Set([...learningExclusions(), ...(args.exclude_ids ?? [])]);
  const { learningSharingEligible } = await import("@/modules/workspaces/store");
  const share = args.allow_cross_workspace === true && await learningSharingEligible(args.workspace_id);
  const pool: DecisionExample[] = [];
  for (const example of await listDecisionExamples({ stage: args.stage, kinds: args.kinds })) {
    if (excluded.has(example.id)) continue;
    if (example.workspace_id === args.workspace_id) { pool.push(example); continue; }
    if (!share || example.lesson_status !== "ok" || !example.lesson) continue;
    try {
      if (!await learningSharingEligible(example.workspace_id)) continue;
      const entities = await entitiesForWorkspace(example.workspace_id);
      const lesson = scrubLesson(example.lesson, rawTextsOf(example), entities);
      if (lesson) pool.push({ ...example, lesson });
    } catch (error) {
      console.error("[learning] foreign lesson withheld: entity context unavailable", example.id, error);
    }
  }
  const ranked = rankBySimilarity(args.text, pool, example => example.workspace_id === args.workspace_id ? exampleText(example) : example.lesson!);
  const own = ranked.filter((row) => row.item.workspace_id === args.workspace_id);
  const others = ranked.filter((row) => row.item.workspace_id !== args.workspace_id);
  return [...own, ...others].slice(0, take).map(({ item }) =>
    item.workspace_id === args.workspace_id
      ? {
          id: item.id,
          scope: "this_plan",
          kind: item.kind,
          case: item.ai_input,
          ai_proposed: item.ai_output,
          reviewer: item.outcome,
          reviewer_final: item.final,
          reason: item.rationale,
        }
      : { id: item.id, scope: "other_plans", kind: item.kind, lesson: item.lesson! },
  );
}

export const WORKED_EXAMPLES_FRAMING =
  "Past reviewer decisions on similar cases, for calibration. They are examples, not rules: follow one only where the case really matches.";

/** The worked examples as the text stages hand their model; "" when there are none. */
export function workedExamplesAsPrompt(examples: WorkedExample[]): string {
  if (examples.length === 0) return "";
  return `${WORKED_EXAMPLES_FRAMING}\n${JSON.stringify(examples)}`;
}

/** Runs evaluation work without allowing its held-out answers into prompts. */
export function withLearningExclusions<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T> {
  return exclusions.run([...new Set([...learningExclusions(), ...ids])], fn);
}
const exclusions = new AsyncLocalStorage<readonly string[]>();
/** IDs withheld from all learning lookups in the current request. */
export function learningExclusions(): readonly string[] { return exclusions.getStore() ?? []; }

/** Resolve recorded workspace identity before reading customer context. */
async function inRecordedWorkspace<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const { getWorkspace } = await import("@/modules/workspaces/store");
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    // The reserved pre-workspace plan lives in public even before its registry row exists.
    if (workspaceId === DEFAULT_WORKSPACE_ID) return runInWorkspace({ workspace_id: DEFAULT_WORKSPACE_ID, schema: DEFAULT_SCHEMA }, fn);
    throw new Error(`Learning workspace ${workspaceId} is unavailable.`);
  }
  return runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, fn);
}
/** Context must load successfully and contain an identifying asset, never an empty fallback. */
async function entitiesForWorkspace(workspaceId: string): Promise<string[]> {
  return inRecordedWorkspace(workspaceId, async () => {
    const names = await workspaceEntityNames();
    if (!names.length) throw new Error("Learning entity context is empty.");
    return names;
  });
}
/** Lookup only explicit originating lineage; never substitute today's configured route. */
async function originatingRun(workspaceId: string, runId: string, stage: StageId) {
  try {
    return await inRecordedWorkspace(workspaceId, async () => {
      const run = await getRun(runId);
      return run?.workspace_id === workspaceId && run.stage === stage ? run : null;
    });
  } catch (error) {
    console.error("[learning] originating run unavailable", runId, error);
    return null;
  }
}
