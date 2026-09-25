import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import {
  PROPOSER_CRITIC_EXCHANGES,
  runAgenticCycle,
  type Critique,
  type JudgedCandidate,
} from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import { augmentSystemPrompt } from "@/modules/kernel/prompt-variant";
import { curatedS3Cases } from "@/modules/eval-gold";
import { scoreMustMatch } from "@/modules/eval-gold/types";
import type { EvalScore, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import {
  TACTIC_STATUSES,
  TACTIC_TYPES,
  type TacticStatus,
  type TacticType,
} from "@/lib/iegp/enums";
import { commitExtractedRecords, loadState } from "@/lib/iegp/store";
import { extractCandidateTactics } from "@/lib/iegp/engine";
import { listParsedDocuments, type ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import { TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL, tacticCandidates } from "./schema";

const inputSchema = z.object({
  document_ids: z.array(z.string()).optional(),
  dry_run: z.boolean().default(false),
});

const candidateSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  source_id: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  evidence_question: z.string(),
  source_quote: z.string(),
  score: z.number(),
  verdict: z.string(),
  critic_note: z.string(),
  /** The library tactic the model judge said this candidate is the same as. */
  duplicate_of: z.string().nullable(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  accepted: z.array(candidateSchema),
  rejected: z.array(candidateSchema),
  committed_tactic_ids: z.array(z.string()),
});

export type TacticExtractInput = z.infer<typeof inputSchema>;
export type TacticExtractOutput = z.infer<typeof outputSchema>;

type TacticCandidate = {
  id: string;
  document_id: string;
  source_id: string;
  name: string;
  type: TacticType;
  status: TacticStatus;
  evidence_question: string;
  source_quote: string;
  /** Set by the judge only; null until then and for a new tactic. */
  duplicate_of: string | null;
};

type LibraryTactic = {
  id: string;
  name: string;
  type: string;
  status: string;
  evidence_question: string;
};

/** A proposer answer for one row: a complete tactic, or the model withdrawing it. */
type ProposerAnswer = { kind: "tactic"; tactic: TacticCandidate } | { kind: "withdrawn"; reason: string };

type Review = { verdict: Critique["verdict"]; confidence: number; note: string };
type Decision = { verdict: "accept" | "reject"; confidence: number; reason: string; duplicate_of: string | null };

const REMEDY = "run tactic extraction again or switch the S3 route in /admin/control.";

const TACTIC_FIELDS = `Each tactic has:
- name: a short name for the activity.
- type: exactly one of ${TACTIC_TYPES.join(", ")}.
- status: exactly one of ${TACTIC_STATUSES.join(", ")}, reflecting what the document says about it.
- evidence_question: the question the tactic answers, in one sentence.
- source_quote: a verbatim sentence or passage from the document that describes the tactic. Never paraphrase and never leave it empty.`;

const TACTIC_PROPOSER_SYSTEM = `You extract tactics already described in pharma evidence-planning source material.

A tactic is a study, analysis, publication or dissemination activity that exists, is running, is planned, or is explicitly proposed in the document. Do not invent tactics and do not turn an evidence gap into a tactic.

${TACTIC_FIELDS}

Return JSON only: {"tactics":[{"name":"","type":"","status":"","evidence_question":"","source_quote":""}]}`;

const TACTIC_REVISER_SYSTEM = `You extracted tactics from pharma evidence-planning source material and now answer for specific rows.

Each row carries its id, what you said before (if anything), and either a validation problem or a critic's objection. For every row, either return a corrected tactic under the same id, or withdraw it when the document does not support it as a tactic. When you disagree with an objection you may return the tactic unchanged, but every field must still be valid.

${TACTIC_FIELDS}

Answer every row you are given.

Return JSON only: {"tactics":[{"id":"","withdraw":false,"reason":"","name":"","type":"","status":"","evidence_question":"","source_quote":""}]}
Set "withdraw": true with a "reason" to withdraw a row; the tactic fields are then ignored.`;

const TACTIC_CRITIC_SYSTEM = `You review tactic candidates extracted from pharma evidence-planning source material before they enter the tactic library of an Integrated Evidence Generation Plan.

For each candidate, check that:
- it is a real study, analysis, publication or dissemination activity the source describes, not an evidence gap or a wish;
- its type and status match what the source quote says;
- its evidence question is a clear, specific question the tactic answers;
- its source quote actually describes it;
- it is not the same activity as a tactic already in the library or as another candidate.

verdict is "keep" when the candidate is right as it stands, "revise" when a field should change, and "drop" when it should not enter the library at all. confidence is 0–100 that the candidate belongs in the library as written. note must be actionable: name the field and what it should become, or name the library tactic id or candidate id it duplicates; for "keep" say briefly why it holds.

Review every candidate you are given.

Return JSON only: {"reviews":[{"id":"","verdict":"keep","confidence":0,"note":""}]}`;

const TACTIC_JUDGE_SYSTEM = `You are the judge deciding which tactic candidates enter the tactic library of a pharma Integrated Evidence Generation Plan. The candidates have been through three rounds of critique and revision; each carries the critic's last review.

For each candidate decide:
- verdict: "accept" when it is a real tactic the source describes, with a defensible type, status, evidence question and quote; otherwise "reject".
- duplicate_of: the id of the existing library tactic it is the same activity as, or the id of another candidate in this batch it repeats; null when it is new. A candidate that repeats another candidate must be rejected — accept the better of the two. A candidate that is the same as a library tactic may be accepted; it is recorded against that tactic instead of being added again.
- confidence: 0–100 in your verdict.
- reason: one or two sentences naming what decided it.

Decide every candidate you are given. The full batch is listed under "batch" so you can spot repeats.

Return JSON only: {"decisions":[{"id":"","verdict":"accept","duplicate_of":null,"confidence":0,"reason":""}]}`;

function documentText(document: ParsedDocumentRecord): string {
  return document.blocks.map((block) => `## ${block.heading}\n${block.text}`).join("\n\n").slice(0, 40_000);
}

type RawTactic = {
  id?: unknown;
  withdraw?: unknown;
  reason?: unknown;
  name?: unknown;
  type?: unknown;
  status?: unknown;
  evidence_question?: unknown;
  source_quote?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** What is wrong with a proposed row, in words the model can act on. Empty when valid. */
function tacticProblems(raw: RawTactic): string[] {
  const problems: string[] = [];
  if (!text(raw.name)) problems.push("name is missing");
  if (!TACTIC_TYPES.includes(text(raw.type) as TacticType)) {
    problems.push(`type "${text(raw.type)}" is not one of ${TACTIC_TYPES.join(", ")}`);
  }
  if (!TACTIC_STATUSES.includes(text(raw.status) as TacticStatus)) {
    problems.push(`status "${text(raw.status)}" is not one of ${TACTIC_STATUSES.join(", ")}`);
  }
  if (!text(raw.evidence_question)) problems.push("evidence_question is missing");
  if (!text(raw.source_quote)) problems.push("source_quote is missing; give the verbatim passage from the document");
  return problems;
}

function toCandidate(document: ParsedDocumentRecord, id: string, raw: RawTactic): TacticCandidate {
  return {
    id,
    document_id: document.id,
    source_id: document.source_id,
    name: text(raw.name),
    type: text(raw.type) as TacticType,
    status: text(raw.status) as TacticStatus,
    evidence_question: text(raw.evidence_question),
    source_quote: text(raw.source_quote),
    duplicate_of: null,
  };
}

const tacticFields = (candidate: TacticCandidate) => ({
  name: candidate.name,
  type: candidate.type,
  status: candidate.status,
  evidence_question: candidate.evidence_question,
  source_quote: candidate.source_quote,
});

type ProposerRow = {
  id: string;
  previous?: RawTactic | ReturnType<typeof tacticFields>;
  problem?: string;
  objection?: string;
};

/**
 * Asks the model to fix or answer for specific rows of one document, re-asking
 * for any row whose answer is incomplete or invalid. Nothing is filled in: a
 * row the model never answers validly fails the stage.
 */
async function answerRows(
  ctx: ModuleContext,
  args: { document: ParsedDocumentRecord; hints: string; rows: ProposerRow[]; purpose: string },
): Promise<Map<string, ProposerAnswer>> {
  const rowById = new Map(args.rows.map((row) => [row.id, { ...row }]));
  return completeAll({
    ids: args.rows.map((row) => row.id),
    what: "tactic",
    describe: (id) => `${id} (${args.document.source_id})`,
    remedy: REMEDY,
    ask: async (missing, attempt) => {
      const payload = (await ctx.complete({
        system: augmentSystemPrompt(TACTIC_REVISER_SYSTEM),
        user: JSON.stringify({
          reviewer_corrections: args.hints || undefined,
          source: args.document.source_id,
          note:
            attempt > 1
              ? "An earlier answer left these rows unanswered or invalid. Answer each, fixing the problem named."
              : undefined,
          rows: missing.map((id) => rowById.get(id)!),
          document: documentText(args.document),
        }),
        purpose: `${args.purpose}:${args.document.id}`,
      })) as { tactics?: RawTactic[] } | null;
      const answers = new Map<string, ProposerAnswer>();
      for (const raw of payload?.tactics ?? []) {
        const id = text(raw.id);
        const row = rowById.get(id);
        if (!row || !missing.includes(id)) continue;
        if (raw.withdraw === true) {
          const reason = text(raw.reason);
          if (reason) answers.set(id, { kind: "withdrawn", reason });
          else row.problem = "withdraw needs a reason";
          continue;
        }
        const problems = tacticProblems(raw);
        if (problems.length > 0) {
          // Left out so it is asked for again, with the problem named.
          row.previous = raw;
          row.problem = problems.join("; ");
          continue;
        }
        answers.set(id, { kind: "tactic", tactic: toCandidate(args.document, id, raw) });
      }
      return answers;
    },
  });
}

/** Round 1: the model lists the tactics in each document; any invalid row is sent back to it. */
async function llmProposals(
  ctx: ModuleContext,
  documents: ParsedDocumentRecord[],
  hints: string,
): Promise<TacticCandidate[]> {
  const out: TacticCandidate[] = [];
  for (const document of documents) {
    const payload = (await ctx.complete({
      system: augmentSystemPrompt(TACTIC_PROPOSER_SYSTEM),
      user: [hints, `Source: ${document.source_id}`, documentText(document)].filter(Boolean).join("\n\n"),
      purpose: `tactic-proposer:${document.id}`,
    })) as { tactics?: RawTactic[] } | null;
    const invalid: ProposerRow[] = [];
    const proposed: { id: string; candidate?: TacticCandidate }[] = [];
    for (const [index, raw] of (payload?.tactics ?? []).entries()) {
      const id = `${document.id}-LT${String(index + 1).padStart(3, "0")}`;
      const problems = tacticProblems(raw);
      if (problems.length > 0) {
        invalid.push({ id, previous: raw, problem: problems.join("; ") });
        proposed.push({ id });
      } else {
        proposed.push({ id, candidate: toCandidate(document, id, raw) });
      }
    }
    const fixed =
      invalid.length > 0
        ? await answerRows(ctx, { document, hints, rows: invalid, purpose: "tactic-proposer-fix" })
        : new Map<string, ProposerAnswer>();
    for (const row of proposed) {
      if (row.candidate) {
        out.push(row.candidate);
        continue;
      }
      const answer = fixed.get(row.id);
      if (answer?.kind === "tactic") out.push(answer.tactic);
    }
  }
  return out;
}

/** Rounds 2+: the model answers each objection — revise, defend, or withdraw. */
async function llmRevisions(
  ctx: ModuleContext,
  args: {
    documents: ParsedDocumentRecord[];
    hints: string;
    round: number;
    previous: TacticCandidate[];
    critiques: Critique[];
  },
): Promise<TacticCandidate[]> {
  const objections = new Map(
    args.critiques
      .filter((critique) => critique.verdict !== "keep")
      .map((critique) => [critique.subject, `${critique.verdict}: ${critique.note}`]),
  );
  if (objections.size === 0) return args.previous;
  const answers = new Map<string, ProposerAnswer>();
  for (const document of args.documents) {
    const rows = args.previous
      .filter((candidate) => candidate.document_id === document.id && objections.has(candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        previous: tacticFields(candidate),
        objection: objections.get(candidate.id),
      }));
    if (rows.length === 0) continue;
    const answered = await answerRows(ctx, {
      document,
      hints: [
        args.hints,
        `Exchange ${args.round - 1} of ${PROPOSER_CRITIC_EXCHANGES}: answer the critic for each row, keeping its id.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      rows,
      purpose: "tactic-proposer-revise",
    });
    for (const [id, answer] of answered) answers.set(id, answer);
  }
  return args.previous.flatMap((candidate) => {
    const answer = answers.get(candidate.id);
    if (!answer) return [candidate];
    return answer.kind === "tactic" ? [answer.tactic] : [];
  });
}

async function llmReviews(
  ctx: ModuleContext,
  args: { candidates: TacticCandidate[]; library: LibraryTactic[]; hints: string; round: number; retry: boolean },
): Promise<Map<string, Review>> {
  const payload = (await ctx.complete({
    system: augmentSystemPrompt(TACTIC_CRITIC_SYSTEM),
    user: JSON.stringify({
      reviewer_corrections: args.hints || undefined,
      exchange: `${args.round} of ${PROPOSER_CRITIC_EXCHANGES}`,
      note: args.retry ? "An earlier answer left these candidates unreviewed. Review each." : undefined,
      library: args.library,
      candidates: args.candidates.map((candidate) => ({
        id: candidate.id,
        source: candidate.source_id,
        ...tacticFields(candidate),
      })),
    }),
    purpose: "tactic-critic",
  })) as { reviews?: { id?: unknown; verdict?: unknown; confidence?: unknown; note?: unknown }[] } | null;
  const map = new Map<string, Review>();
  for (const row of payload?.reviews ?? []) {
    const id = text(row.id);
    if (!id) continue;
    if (row.verdict !== "keep" && row.verdict !== "revise" && row.verdict !== "drop") continue;
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) continue;
    const note = text(row.note);
    if (!note) continue;
    map.set(id, {
      verdict: row.verdict,
      confidence: Math.max(0, Math.min(100, Math.round(row.confidence))),
      note,
    });
  }
  return map;
}

async function llmDecisions(
  ctx: ModuleContext,
  args: {
    batch: TacticCandidate[];
    ask: string[];
    critiques: Critique[];
    library: LibraryTactic[];
    hints: string;
    retry: boolean;
  },
): Promise<Map<string, Decision>> {
  const critiqueOf = (id: string) => args.critiques.find((critique) => critique.subject === id);
  const payload = (await ctx.complete({
    system: augmentSystemPrompt(TACTIC_JUDGE_SYSTEM),
    user: JSON.stringify({
      reviewer_corrections: args.hints || undefined,
      note: args.retry
        ? "An earlier answer left these candidates undecided or invalid. Decide each; duplicate_of must be null, a library id, or another candidate's id (and a candidate that repeats another candidate is rejected)."
        : undefined,
      library: args.library,
      batch: args.batch.map((candidate) => ({ id: candidate.id, name: candidate.name, evidence_question: candidate.evidence_question })),
      decide: args.batch
        .filter((candidate) => args.ask.includes(candidate.id))
        .map((candidate) => {
          const critique = critiqueOf(candidate.id);
          return {
            id: candidate.id,
            source: candidate.source_id,
            ...tacticFields(candidate),
            critic: critique
              ? { verdict: critique.verdict, confidence: critique.score, note: critique.note }
              : undefined,
          };
        }),
    }),
    purpose: "tactic-judge",
  })) as {
    decisions?: { id?: unknown; verdict?: unknown; duplicate_of?: unknown; confidence?: unknown; reason?: unknown }[];
  } | null;
  const libraryIds = new Set(args.library.map((tactic) => tactic.id));
  const batchIds = new Set(args.batch.map((candidate) => candidate.id));
  const map = new Map<string, Decision>();
  for (const row of payload?.decisions ?? []) {
    const id = text(row.id);
    if (!id) continue;
    if (row.verdict !== "accept" && row.verdict !== "reject") continue;
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) continue;
    const reason = text(row.reason);
    if (!reason) continue;
    // duplicate_of must be answered: null for new, or an id the judge was shown.
    if (!("duplicate_of" in row)) continue;
    let duplicate_of: string | null = null;
    if (row.duplicate_of !== null) {
      const target = text(row.duplicate_of);
      const sibling = batchIds.has(target) && target !== id;
      if (!libraryIds.has(target) && !sibling) continue;
      // A repeat of another candidate never enters the library.
      if (sibling && row.verdict !== "reject") continue;
      duplicate_of = target;
    }
    map.set(id, {
      verdict: row.verdict,
      confidence: Math.max(0, Math.min(100, Math.round(row.confidence))),
      reason,
      duplicate_of,
    });
  }
  return map;
}

/**
 * Test stub only: exact-name matches stand in for the model judge so the
 * pipeline tests can exercise re-runs. Never runs outside SYNAPSE_TEST_STUB_LLM.
 */
function stubDecisions(candidates: TacticCandidate[], library: LibraryTactic[]): Map<string, Decision> {
  const key = (name: string) => name.trim().toLowerCase();
  const seen = new Map<string, string>();
  const map = new Map<string, Decision>();
  for (const candidate of candidates) {
    const inLibrary = library.find((tactic) => key(tactic.name) === key(candidate.name));
    const sibling = seen.get(key(candidate.name));
    if (!sibling) seen.set(key(candidate.name), candidate.id);
    map.set(candidate.id, {
      verdict: sibling ? "reject" : "accept",
      confidence: 50,
      reason: "Test stub: exact-name match only; no model judge was called.",
      duplicate_of: inLibrary?.id ?? sibling ?? null,
    });
  }
  return map;
}

function withJudgeMetrics(metrics: EvalScore[], judged: JudgedCandidate<TacticCandidate>[]): EvalScore[] {
  const accepted = judged.filter((item) => item.verdict === "accept").length;
  const confidence =
    judged.length === 0 ? 0 : judged.reduce((sum, item) => sum + item.score, 0) / judged.length / 100;
  return metrics.map((metric) => {
    if (metric.name === "accept_rate") {
      return { ...metric, value: judged.length === 0 ? 0 : Number((accepted / judged.length).toFixed(3)) };
    }
    if (metric.name === "judge_confidence") return { ...metric, value: Number(confidence.toFixed(3)) };
    return metric;
  });
}

export const tacticExtractModule: SynapseModule<TacticExtractInput, TacticExtractOutput> = {
  manifest: {
    id: "s3-tactic-extract.pcj",
    stage: "S3",
    version: "2.0.0",
    title: "Tactic extraction (proposer → critic → judge)",
    summary:
      "A model proposes the tactics the source material describes, a model critic challenges each over three exchanges, and a model judge decides what enters the library and what duplicates it. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "llm-critic", "llm-judge", "hillclimb-hints"],
  },
  inputSchema,
  outputSchema,
  migrations: [TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL],
  async run(input, ctx) {
    requireLlm(ctx, "Tactic extraction");
    const documents = await listParsedDocuments(input.document_ids);
    if (documents.length === 0) {
      return {
        output: {
          mode: isTestStub() ? "deterministic" : "llm",
          proposed: 0,
          accepted: [],
          rejected: [],
          committed_tactic_ids: [],
        },
        summary: "No parsed documents to extract from",
      };
    }
    const state = await loadState();
    const library: LibraryTactic[] = state.tactics.map((tactic) => ({
      id: tactic.id,
      name: tactic.name,
      type: tactic.type,
      status: tactic.status,
      evidence_question: tactic.evidence_question,
    }));
    // The kernel hands reviewer corrections to the proposer; the critic and judge weigh them too.
    let reviewerHints = "";

    const outcome = await runAgenticCycle<TacticCandidate>(ctx, "S3", {
      subjectOf: (candidate) => candidate.id,
      proposer: {
        /**
         * Test stub only: the kernel calls this when SYNAPSE_TEST_STUB_LLM is set
         * and never otherwise. Candidates come from the engine's sentence cues
         * and are never revised; no model ran.
         */
        local: ({ round, previous }) => {
          if (!isTestStub()) throw new NoRouteError("Tactic extraction has no rule-based fallback.");
          if (round > 1) return previous;
          return documents.flatMap((document) =>
            extractCandidateTactics(document.blocks).map((tactic, index) => ({
              id: `${document.id}-T${String(index + 1).padStart(3, "0")}`,
              document_id: document.id,
              source_id: document.source_id,
              name: tactic.name,
              type: tactic.type,
              status: tactic.status,
              evidence_question: tactic.evidence_question,
              source_quote: tactic.source_quote,
              duplicate_of: null,
            })),
          );
        },
        llm: async ({ hints, round, critiques, previous }) => {
          reviewerHints = hints;
          if (round === 1) return llmProposals(ctx, documents, hints);
          return llmRevisions(ctx, { documents, hints, round, previous, critiques });
        },
      },
      critic: async (candidates, round) => {
        if (isTestStub()) {
          return candidates.map((candidate) => ({
            subject: candidate.id,
            verdict: "keep" as const,
            note: "Test stub: no model critic was called.",
            score: 50,
          }));
        }
        const reviews = await completeAll({
          ids: candidates.map((candidate) => candidate.id),
          what: "review",
          describe: (id) => candidates.find((candidate) => candidate.id === id)?.name ?? id,
          remedy: REMEDY,
          ask: (missing, attempt) =>
            llmReviews(ctx, {
              candidates: candidates.filter((candidate) => missing.includes(candidate.id)),
              library,
              hints: reviewerHints,
              round,
              retry: attempt > 1,
            }),
        });
        return candidates.map((candidate) => {
          const review = reviews.get(candidate.id)!;
          return { subject: candidate.id, verdict: review.verdict, note: review.note, score: review.confidence };
        });
      },
      /**
       * The kernel's judge is synchronous, so it only hands the survivors on.
       * The model judge below decides every one of them.
       */
      judge: ({ candidates, critiques }) =>
        candidates.map((candidate) => {
          const critique = critiques.find((item) => item.subject === candidate.id);
          return {
            candidate,
            subject: candidate.id,
            verdict: "accept" as const,
            score: critique?.score ?? 0,
            note: critique?.note ?? "not reviewed",
          };
        }),
    });

    const survivors = outcome.judged.map((item) => item.candidate);
    const decisions = await ctx.run.step(
      "judge:model",
      () =>
        isTestStub()
          ? Promise.resolve(stubDecisions(survivors, library))
          : completeAll({
              ids: survivors.map((candidate) => candidate.id),
              what: "judge decision",
              describe: (id) => survivors.find((candidate) => candidate.id === id)?.name ?? id,
              remedy: REMEDY,
              ask: (missing, attempt) =>
                llmDecisions(ctx, {
                  batch: survivors,
                  ask: missing,
                  critiques: outcome.critiques,
                  library,
                  hints: reviewerHints,
                  retry: attempt > 1,
                }),
            }),
      `${survivors.length} candidate(s) for the model judge`,
    );
    const judged: JudgedCandidate<TacticCandidate>[] = survivors.map((candidate) => {
      const decision = decisions.get(candidate.id)!;
      return {
        candidate: { ...candidate, duplicate_of: decision.duplicate_of },
        subject: candidate.id,
        verdict: decision.verdict,
        score: decision.confidence,
        note: decision.reason,
      };
    });
    const accepted = judged.filter((item) => item.verdict === "accept").map((item) => item.candidate);
    const rejected = judged.filter((item) => item.verdict === "reject");

    const rows = judged.map((item) => ({
      id: newId("tc"),
      run_id: ctx.run.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      type: item.candidate.type,
      status: item.candidate.status,
      evidence_question: item.candidate.evidence_question,
      source_quote: item.candidate.source_quote,
      score: item.score,
      verdict: item.verdict,
      critic_note: item.note,
      duplicate_of: item.candidate.duplicate_of,
      proposer: outcome.mode,
      created_at: nowIso(),
    }));
    if (rows.length > 0) await db().insert(tacticCandidates).values(rows);

    const committed_tactic_ids: string[] = [];
    if (!input.dry_run) {
      for (const document of documents) {
        const fromDocument = accepted.filter((candidate) => candidate.document_id === document.id);
        if (fromDocument.length === 0) continue;
        const source = state.sources.find((row) => row.id === document.source_id);
        const result = await ctx.run.step(`commit:${document.id}`, () =>
          commitExtractedRecords({
            source_id: document.source_id,
            title: source?.title ?? document.source_id,
            stakeholder_function: source?.stakeholder_function ?? ctx.actor.function,
            actor_name: ctx.actor.name,
            actor_function: ctx.actor.function,
            needs: [],
            gaps: [],
            tactics: fromDocument.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              type: candidate.type,
              status: candidate.status,
              evidence_question: candidate.evidence_question,
              source_id: candidate.source_id,
              source_quote: candidate.source_quote,
              duplicate_of: candidate.duplicate_of,
            })),
            apply_mappings: false,
          }),
        );
        committed_tactic_ids.push(...result.tactic_ids);
      }
    }

    const toOut = (item: JudgedCandidate<TacticCandidate>) => ({
      id: item.candidate.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      type: item.candidate.type,
      status: item.candidate.status,
      evidence_question: item.candidate.evidence_question,
      source_quote: item.candidate.source_quote,
      score: item.score,
      verdict: item.verdict,
      critic_note: item.note,
      duplicate_of: item.candidate.duplicate_of,
    });

    return {
      output: {
        mode: outcome.mode,
        proposed: outcome.proposed.length,
        accepted: judged.filter((item) => item.verdict === "accept").map(toOut),
        rejected: rejected.map(toOut),
        committed_tactic_ids,
      },
      summary: `${accepted.length} of ${outcome.proposed.length} tactic candidate(s) accepted${
        input.dry_run ? " (dry run)" : `, ${committed_tactic_ids.length} added to the library`
      }`,
      evals: withJudgeMetrics(outcome.metrics, judged),
    };
  },
  evals: {
    async cases() {
      const curated = await curatedS3Cases();
      if (curated.length > 0) return curated;
      const documents = await listParsedDocuments();
      return documents.slice(0, 3).map((document) => ({
        name: document.source_id,
        input: { document_ids: [document.id], dry_run: true },
      }));
    },
    score({ case: testCase, output }) {
      const accepted = output.accepted;
      const real = accepted.filter((candidate) => candidate.status !== "proposed").length;
      // Nothing accepted means the library already covers the document, which is
      // not a quality failure, so those cases carry no target.
      const curated = scoreMustMatch(
        accepted.map((row) => row.evidence_question),
        testCase.gold?.must_match,
      );
      if (accepted.length === 0) {
        return [
          { name: "curated_must_match", value: curated.value, unit: "ratio", target: testCase.gold?.must_match ? 0.3 : undefined, detail: curated.detail },
          { name: "accepted_with_quote", value: 0, unit: "ratio", detail: "no new candidates" },
          { name: "real_inventory_share", value: 0, unit: "ratio", detail: "no new candidates" },
        ];
      }
      return [
        { name: "curated_must_match", value: curated.value, unit: "ratio", target: testCase.gold?.must_match ? 0.3 : undefined, detail: curated.detail },
        {
          name: "accepted_with_quote",
          value:
            accepted.length === 0
              ? 0
              : Number(
                  (accepted.filter((candidate) => candidate.source_quote.trim().length > 0).length /
                    accepted.length).toFixed(3),
                ),
          unit: "ratio",
          target: 1,
        },
        {
          name: "real_inventory_share",
          value: accepted.length === 0 ? 0 : Number((real / accepted.length).toFixed(3)),
          unit: "ratio",
        },
      ];
    },
  },
};

registerModule(tacticExtractModule);

export async function listTacticCandidates(limit = 200) {
  await ensurePlatformSchema([TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL]);
  return db().select().from(tacticCandidates).orderBy(desc(tacticCandidates.created_at)).limit(limit);
}
