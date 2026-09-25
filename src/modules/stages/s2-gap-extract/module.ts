import { desc, eq } from "drizzle-orm";
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
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { EVIDENCE_DOMAINS, type EvidenceDomain } from "@/lib/iegp/enums";
import { commitExtractedRecords, loadState } from "@/lib/iegp/store";
import { extractCandidateGaps, isLiveGap } from "@/lib/iegp/engine";
import { listParsedDocuments, type ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import { GAP_CANDIDATES_DDL, gapCandidates } from "./schema";
import { augmentSystemPrompt } from "@/modules/kernel/prompt-variant";
import { curatedS2Cases } from "@/modules/eval-gold";
import { scoreMustMatch } from "@/modules/eval-gold/types";
import {
  GAP_CRITIC_SYSTEM,
  GAP_JUDGE_SYSTEM,
  GAP_PROPOSER_SYSTEM,
  GAP_REVISER_SYSTEM,
  documentBody,
  gapProposerUser,
} from "./prompts";

const inputSchema = z.object({
  /** Defaults to every parsed document. */
  document_ids: z.array(z.string()).optional(),
  /** Propose and judge without committing to the domain store. Used by evals. */
  dry_run: z.boolean().default(false),
});

const candidateSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  source_id: z.string(),
  name: z.string(),
  statement: z.string(),
  domain: z.string(),
  source_quote: z.string(),
  /** The judge's confidence in its verdict, 0–100, as the model gave it. */
  score: z.number(),
  verdict: z.string(),
  critic_note: z.string(),
  /** Existing live plan gap the judge found this candidate to be the same as. */
  duplicate_of: z.string().nullable(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  accepted: z.array(candidateSchema),
  rejected: z.array(candidateSchema),
  committed_gap_ids: z.array(z.string()),
  committed_need_ids: z.array(z.string()),
});

export type GapExtractInput = z.infer<typeof inputSchema>;
export type GapExtractOutput = z.infer<typeof outputSchema>;

type GapCandidate = {
  id: string;
  document_id: string;
  source_id: string;
  name: string;
  statement: string;
  domain: EvidenceDomain;
  source_quote: string;
  /** Set only by the model judge. Null until then, and for a new gap. */
  duplicate_of: string | null;
};

/**
 * A gap already in the plan. `set_aside` marks one a person excluded or parked:
 * it is still shown to the critic and judge so a repeat maps onto it
 * (duplicate_of) instead of re-creating a gap the person set aside.
 */
type PlanGap = { id: string; name: string; statement: string; set_aside?: "excluded" | "parked" };

const SET_ASIDE_NOTE =
  "plan_gaps marked set_aside were excluded or parked by a person. A candidate asking the same question is still a duplicate: set duplicate_of to that gap's id. It joins as provenance and the gap stays set aside.";

type RawGap = {
  id?: unknown;
  withdraw?: unknown;
  reason?: unknown;
  name?: unknown;
  statement?: unknown;
  domain?: unknown;
  source_quote?: unknown;
};

type JudgeDecision = {
  verdict: "accept" | "reject";
  confidence: number;
  reason: string;
  duplicate_of: string | null;
  same_as_candidate: string | null;
};

const REMEDY = "run gap extraction again or switch the S2 route in /admin/control.";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Schema check on one proposed gap. A row with any problem is not used as is:
 * the proposer is asked to fix it or withdraw it. Nothing is filled in here.
 */
function gapProblems(raw: RawGap): string[] {
  const problems: string[] = [];
  if (!text(raw.name)) problems.push("name is missing");
  if (!text(raw.statement)) problems.push("statement is missing");
  const domain = text(raw.domain);
  if (!EVIDENCE_DOMAINS.includes(domain as EvidenceDomain)) {
    problems.push(
      domain
        ? `domain "${domain}" is not one of: ${EVIDENCE_DOMAINS.join(", ")}`
        : `domain is missing; use one of: ${EVIDENCE_DOMAINS.join(", ")}`,
    );
  }
  if (!text(raw.source_quote)) problems.push("source_quote is missing; quote the document verbatim or withdraw the gap");
  return problems;
}

function toCandidate(id: string, document: ParsedDocumentRecord, raw: RawGap): GapCandidate {
  return {
    id,
    document_id: document.id,
    source_id: document.source_id,
    name: text(raw.name),
    statement: text(raw.statement),
    domain: text(raw.domain) as EvidenceDomain,
    source_quote: text(raw.source_quote),
    duplicate_of: null,
  };
}

const titleOf = (document: ParsedDocumentRecord) => document.blocks[0]?.heading ?? document.source_id;

/**
 * Test stub only: the kernel calls this when SYNAPSE_TEST_STUB_LLM is set and
 * never otherwise. Rule-based extraction stands in for the model so the rest of
 * the pipeline has rows to work with; it is labelled test output, not judgement.
 */
function stubProposals(documents: ParsedDocumentRecord[]): GapCandidate[] {
  if (!isTestStub()) throw new NoRouteError("Gap extraction has no rule-based fallback.");
  return documents.flatMap((document) =>
    extractCandidateGaps(document.blocks).map((gap, index) => ({
      id: `${document.id}-G${String(index + 1).padStart(3, "0")}`,
      document_id: document.id,
      source_id: document.source_id,
      name: gap.name,
      statement: gap.statement,
      domain: gap.domain,
      source_quote: gap.source_quote,
      duplicate_of: null,
    })),
  );
}

type RevisionItem = {
  candidate: Pick<GapCandidate, "id"> & Partial<Omit<GapCandidate, "id">>;
  /** The critic's objection this revision answers. */
  objection?: string;
  /** What made the candidate incomplete or invalid. */
  problems?: string[];
};

/**
 * The proposer model answers each item: a complete, valid revision or a
 * withdrawal with a reason. An item it never answers fails the run.
 */
async function reviseWithModel(
  ctx: ModuleContext,
  args: { document: ParsedDocumentRecord; hints: string; exchange: string; items: RevisionItem[] },
): Promise<Map<string, GapCandidate | null>> {
  const byId = new Map(args.items.map((item) => [item.candidate.id, item]));
  const lastProblems = new Map<string, string[]>();
  const answers = await completeAll<GapCandidate | null>({
    ids: args.items.map((item) => item.candidate.id),
    what: "gap revision",
    remedy: REMEDY,
    ask: async (missing, attempt) => {
      const payload = (await ctx.complete({
        system: augmentSystemPrompt(GAP_REVISER_SYSTEM),
        user: JSON.stringify({
          source_document: titleOf(args.document),
          exchange: args.exchange,
          reviewer_corrections: args.hints || undefined,
          note:
            attempt > 1
              ? "An earlier answer left these candidates unanswered, incomplete or invalid. Revise each completely or withdraw it with a reason."
              : undefined,
          candidates: missing.map((id) => {
            const item = byId.get(id)!;
            return {
              id,
              name: item.candidate.name,
              statement: item.candidate.statement,
              domain: item.candidate.domain,
              source_quote: item.candidate.source_quote,
              objection: item.objection,
              problems: lastProblems.get(id) ?? item.problems,
            };
          }),
          document: documentBody(args.document.blocks),
        }),
        purpose: `gap-reviser:${args.document.id}`,
      })) as { gaps?: RawGap[] } | null;
      const map = new Map<string, GapCandidate | null>();
      for (const row of payload?.gaps ?? []) {
        const id = text(row.id);
        if (!missing.includes(id) || map.has(id)) continue;
        if (row.withdraw === true) {
          const reason = text(row.reason);
          if (reason) {
            ctx.run.note("proposer:withdrew", { id, reason });
            map.set(id, null);
          } else {
            lastProblems.set(id, ["a withdrawal needs a reason"]);
          }
          continue;
        }
        const problems = gapProblems(row);
        if (problems.length > 0) {
          lastProblems.set(id, problems);
          continue;
        }
        map.set(id, toCandidate(id, args.document, row));
      }
      return map;
    },
  });
  return answers;
}

/** First proposal for one document; incomplete rows go back to the model. */
async function proposeFromDocument(
  ctx: ModuleContext,
  document: ParsedDocumentRecord,
  hints: string,
): Promise<GapCandidate[]> {
  const payload = (await ctx.complete({
    system: augmentSystemPrompt(GAP_PROPOSER_SYSTEM),
    user: gapProposerUser({ title: titleOf(document), blocks: document.blocks, hints }),
    purpose: `gap-proposer:${document.id}`,
  })) as { gaps?: RawGap[] } | null;
  const drafts = (payload?.gaps ?? [])
    .filter((gap) => gap && typeof gap === "object")
    .filter((gap) => [gap.name, gap.statement, gap.domain, gap.source_quote].some((field) => text(field)))
    .map((gap, index) => ({ id: `${document.id}-L${String(index + 1).padStart(3, "0")}`, raw: gap }));
  const incomplete = drafts
    .map((draft) => ({ ...draft, problems: gapProblems(draft.raw) }))
    .filter((draft) => draft.problems.length > 0);
  const repaired =
    incomplete.length === 0
      ? new Map<string, GapCandidate | null>()
      : await reviseWithModel(ctx, {
          document,
          hints,
          exchange: "initial proposal",
          items: incomplete.map((draft) => ({
            candidate: {
              id: draft.id,
              name: text(draft.raw.name),
              statement: text(draft.raw.statement),
              domain: text(draft.raw.domain) as EvidenceDomain,
              source_quote: text(draft.raw.source_quote),
            },
            problems: draft.problems,
          })),
        });
  return drafts.flatMap((draft) => {
    if (!repaired.has(draft.id)) return [toCandidate(draft.id, document, draft.raw)];
    const fixed = repaired.get(draft.id);
    return fixed ? [fixed] : [];
  });
}

type Review = { verdict: Critique["verdict"]; confidence: number; note: string; issues?: string[] };

async function reviewWithModel(
  ctx: ModuleContext,
  args: {
    candidates: GapCandidate[];
    documents: Map<string, ParsedDocumentRecord>;
    planGaps: PlanGap[];
    hints: string;
    round: number;
  },
): Promise<Map<string, Review>> {
  const byId = new Map(args.candidates.map((candidate) => [candidate.id, candidate]));
  return completeAll<Review>({
    ids: args.candidates.map((candidate) => candidate.id),
    what: "review",
    describe: (id) => byId.get(id)?.name || id,
    remedy: REMEDY,
    ask: async (missing, attempt) => {
      const payload = (await ctx.complete({
        system: GAP_CRITIC_SYSTEM,
        user: JSON.stringify({
          exchange: `${args.round} of ${PROPOSER_CRITIC_EXCHANGES}`,
          reviewer_corrections: args.hints || undefined,
          note: attempt > 1 ? "An earlier answer left these candidates unreviewed. Review each." : undefined,
          plan_gaps: args.planGaps,
          plan_gaps_note: args.planGaps.some((gap) => gap.set_aside) ? SET_ASIDE_NOTE : undefined,
          candidates: missing.map((id) => {
            const candidate = byId.get(id)!;
            const document = args.documents.get(candidate.document_id);
            return {
              subject: id,
              source_document: document ? titleOf(document) : candidate.source_id,
              name: candidate.name,
              statement: candidate.statement,
              domain: candidate.domain,
              source_quote: candidate.source_quote,
            };
          }),
        }),
        purpose: "gap-critic",
      })) as {
        critiques?: { subject?: unknown; verdict?: unknown; confidence?: unknown; note?: unknown; issues?: unknown }[];
      } | null;
      const map = new Map<string, Review>();
      for (const row of payload?.critiques ?? []) {
        const subject = text(row.subject);
        if (!missing.includes(subject)) continue;
        if (row.verdict !== "keep" && row.verdict !== "revise" && row.verdict !== "drop") continue;
        if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) continue;
        const note = text(row.note);
        if (!note) continue;
        const issues = Array.isArray(row.issues)
          ? row.issues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
          : undefined;
        map.set(subject, {
          verdict: row.verdict,
          confidence: Math.max(0, Math.min(100, Math.round(row.confidence))),
          note,
          issues: issues?.length ? issues : undefined,
        });
      }
      return map;
    },
  });
}

async function judgeWithModel(
  ctx: ModuleContext,
  args: { candidates: GapCandidate[]; critiques: Critique[]; planGaps: PlanGap[]; hints: string },
): Promise<Map<string, JudgeDecision>> {
  const byId = new Map(args.candidates.map((candidate) => [candidate.id, candidate]));
  const planIds = new Set(args.planGaps.map((gap) => gap.id));
  const lastProblems = new Map<string, string[]>();
  return completeAll<JudgeDecision>({
    ids: args.candidates.map((candidate) => candidate.id),
    what: "judge decision",
    describe: (id) => byId.get(id)?.name || id,
    remedy: REMEDY,
    ask: async (missing, attempt) => {
      const payload = (await ctx.complete({
        system: GAP_JUDGE_SYSTEM,
        user: JSON.stringify({
          reviewer_corrections: args.hints || undefined,
          note:
            attempt > 1
              ? "An earlier answer left these candidates undecided or its decision was invalid. Decide each."
              : undefined,
          plan_gaps: args.planGaps,
          plan_gaps_note: args.planGaps.some((gap) => gap.set_aside) ? SET_ASIDE_NOTE : undefined,
          // Every candidate is listed so a sibling duplicate can name the one it matches.
          candidates: args.candidates.map((candidate) => {
            const critique = args.critiques.find((item) => item.subject === candidate.id);
            return {
              subject: candidate.id,
              decide: missing.includes(candidate.id),
              name: candidate.name,
              statement: candidate.statement,
              domain: candidate.domain,
              source_quote: candidate.source_quote,
              critic: critique
                ? { verdict: critique.verdict, confidence: critique.score, note: critique.note }
                : undefined,
              problems: lastProblems.get(candidate.id),
            };
          }),
        }),
        purpose: "gap-judge",
      })) as {
        decisions?: {
          subject?: unknown;
          verdict?: unknown;
          confidence?: unknown;
          reason?: unknown;
          duplicate_of?: unknown;
          same_as_candidate?: unknown;
        }[];
      } | null;
      const map = new Map<string, JudgeDecision>();
      for (const row of payload?.decisions ?? []) {
        const subject = text(row.subject);
        if (!missing.includes(subject) || map.has(subject)) continue;
        const problems: string[] = [];
        const verdict = row.verdict === "accept" || row.verdict === "reject" ? row.verdict : null;
        if (!verdict) problems.push('verdict must be "accept" or "reject"');
        const confidence =
          typeof row.confidence === "number" && Number.isFinite(row.confidence)
            ? Math.max(0, Math.min(100, Math.round(row.confidence)))
            : null;
        if (confidence === null) problems.push("confidence must be a number from 0 to 100");
        const reason = text(row.reason);
        if (!reason) problems.push("reason is missing");
        const duplicateOf = text(row.duplicate_of) || null;
        if (duplicateOf && !planIds.has(duplicateOf)) {
          problems.push(`duplicate_of "${duplicateOf}" is not a plan gap id`);
        }
        const sameAs = text(row.same_as_candidate) || null;
        if (sameAs && (sameAs === subject || !byId.has(sameAs))) {
          problems.push(`same_as_candidate "${sameAs}" is not another candidate id`);
        }
        if (sameAs && verdict === "accept") {
          problems.push("a candidate that repeats another candidate must be rejected");
        }
        if (problems.length > 0) {
          lastProblems.set(subject, problems);
          continue;
        }
        map.set(subject, {
          verdict: verdict!,
          confidence: confidence!,
          reason,
          duplicate_of: duplicateOf,
          same_as_candidate: sameAs,
        });
      }
      return map;
    },
  });
}

export const gapExtractModule: SynapseModule<GapExtractInput, GapExtractOutput> = {
  manifest: {
    id: "s2-gap-extract.pcj",
    stage: "S2",
    version: "1.0.0",
    title: "Gap extraction (proposer → critic → judge)",
    summary:
      "A model proposes evidence gaps per parsed document, a model critic challenges them over three exchanges, and a model judge decides what commits and which plan gaps they duplicate. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "llm-critic", "llm-judge", "hillclimb-hints"],
  },
  inputSchema,
  outputSchema,
  migrations: [GAP_CANDIDATES_DDL],
  async run(input, ctx) {
    requireLlm(ctx, "Gap extraction");
    const documents = await listParsedDocuments(input.document_ids);
    if (documents.length === 0) {
      return {
        output: {
          mode: isTestStub() ? "deterministic" : "llm",
          proposed: 0,
          accepted: [],
          rejected: [],
          committed_gap_ids: [],
          committed_need_ids: [],
        },
        summary: "No parsed documents to extract from; no model was called",
      };
    }
    const state = await loadState();
    // Excluded and parked gaps are listed too (marked set_aside) so the judge maps
    // a repeat onto them; commit then leaves them excluded or parked.
    const planGaps: PlanGap[] = state.gaps
      .filter((gap) => !gap.retired)
      .map((gap) => ({
        id: gap.id,
        name: gap.name,
        statement: gap.statement,
        ...(isLiveGap(gap)
          ? {}
          : { set_aside: gap.status === "excluded" ? ("excluded" as const) : ("parked" as const) }),
      }));
    const documentById = new Map(documents.map((document) => [document.id, document]));
    // The kernel hands reviewer corrections to the proposer; the critic and judge weigh them too.
    let reviewerHints = "";
    // The model judge runs as soon as the proposer's last revision is in; the
    // kernel's synchronous judge step then reports its decisions.
    let decisions: Map<string, JudgeDecision> | null = null;

    const outcome = await runAgenticCycle<GapCandidate>(ctx, "S2", {
      subjectOf: (candidate) => candidate.id,
      proposer: {
        local: ({ round, previous }) => {
          if (!isTestStub()) throw new NoRouteError("Gap extraction has no rule-based fallback.");
          return round === 1 ? stubProposals(documents) : previous;
        },
        llm: async ({ hints, round, critiques, previous }) => {
          reviewerHints = hints;
          let candidates: GapCandidate[];
          if (round === 1) {
            candidates = [];
            for (const document of documents) {
              candidates.push(...(await proposeFromDocument(ctx, document, hints)));
            }
          } else {
            // Revisions answer only what the critic objected to.
            const objections = new Map(
              critiques
                .filter((critique) => critique.verdict !== "keep")
                .map((critique) => [critique.subject, `${critique.verdict}: ${critique.note}`]),
            );
            const revised = new Map<string, GapCandidate | null>();
            for (const document of documents) {
              const items = previous
                .filter((candidate) => candidate.document_id === document.id && objections.has(candidate.id))
                .map((candidate) => ({ candidate, objection: objections.get(candidate.id) }));
              if (items.length === 0) continue;
              const answers = await reviseWithModel(ctx, {
                document,
                hints,
                exchange: `revision after critique ${round - 1} of ${PROPOSER_CRITIC_EXCHANGES}`,
                items,
              });
              for (const [id, answer] of answers) revised.set(id, answer);
            }
            candidates = previous.flatMap((candidate) => {
              if (!revised.has(candidate.id)) return [candidate];
              const answer = revised.get(candidate.id);
              return answer ? [answer] : [];
            });
          }
          if (round === PROPOSER_CRITIC_EXCHANGES + 1) {
            decisions =
              candidates.length === 0
                ? new Map()
                : await ctx.run.step(
                    "judge:model",
                    () => judgeWithModel(ctx, { candidates, critiques, planGaps, hints }),
                    `${candidates.length} candidate(s) for the model judge`,
                  );
          }
          return candidates;
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
        if (candidates.length === 0) return [];
        const reviews = await reviewWithModel(ctx, {
          candidates,
          documents: documentById,
          planGaps,
          hints: reviewerHints,
          round,
        });
        return candidates.map((candidate) => {
          const review = reviews.get(candidate.id)!;
          return {
            subject: candidate.id,
            verdict: review.verdict,
            note: review.note,
            score: review.confidence,
            issues: review.issues,
          };
        });
      },
      judge: ({ candidates, critiques }): JudgedCandidate<GapCandidate>[] => {
        if (isTestStub()) {
          return candidates.map((candidate) => ({
            candidate,
            subject: candidate.id,
            verdict: "accept" as const,
            score: critiques.find((item) => item.subject === candidate.id)?.score ?? 50,
            note: "Test stub: no model judge was called.",
          }));
        }
        const decided = decisions;
        if (!decided) throw new Error("The model judge did not run. Nothing was saved; " + REMEDY);
        return candidates.map((candidate) => {
          const decision = decided.get(candidate.id);
          if (!decision) {
            throw new Error(`The model judge did not decide ${candidate.name || candidate.id}. Nothing was saved; ${REMEDY}`);
          }
          const note = decision.same_as_candidate
            ? `${decision.reason} (same as candidate ${decision.same_as_candidate})`
            : decision.duplicate_of
              ? `${decision.reason} (same as plan gap ${decision.duplicate_of})`
              : decision.reason;
          return {
            candidate: { ...candidate, duplicate_of: decision.duplicate_of },
            subject: candidate.id,
            verdict: decision.verdict,
            score: decision.confidence,
            note,
          };
        });
      },
    });

    const rows = outcome.judged.map((item) => ({
      id: newId("gc"),
      run_id: ctx.run.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      statement: item.candidate.statement,
      domain: item.candidate.domain,
      source_quote: item.candidate.source_quote,
      score: item.score,
      verdict: item.verdict,
      critic_note: item.note,
      proposer: outcome.mode,
      committed_gap_id: null as string | null,
      created_at: nowIso(),
    }));
    if (rows.length > 0) await db().insert(gapCandidates).values(rows);

    const committed_gap_ids: string[] = [];
    const committed_need_ids: string[] = [];
    if (!input.dry_run) {
      for (const document of documents) {
        const accepted = outcome.accepted.filter(
          (candidate) => candidate.document_id === document.id,
        );
        if (accepted.length === 0) continue;
        const source = state.sources.find((row) => row.id === document.source_id);
        const result = await ctx.run.step(`commit:${document.id}`, () =>
          commitExtractedRecords({
            source_id: document.source_id,
            title: source?.title ?? document.source_id,
            stakeholder_function: source?.stakeholder_function ?? ctx.actor.function,
            actor_name: ctx.actor.name,
            actor_function: ctx.actor.function,
            needs: accepted.map((candidate) => ({
              id: candidate.id,
              statement: candidate.statement,
              source_quote: candidate.source_quote,
            })),
            gaps: accepted.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              statement: candidate.statement,
              domain: candidate.domain,
              source_id: candidate.source_id,
              source_quote: candidate.source_quote,
              // The model judge's call; commit merges only when it is set.
              duplicate_of: candidate.duplicate_of,
            })),
            tactics: [],
            apply_mappings: false,
          }),
        );
        committed_gap_ids.push(...result.gap_ids);
        committed_need_ids.push(...result.need_ids);
      }
    }

    const toOut = (item: (typeof outcome.judged)[number]) => ({
      id: item.candidate.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      statement: item.candidate.statement,
      domain: item.candidate.domain,
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
        accepted: outcome.judged.filter((item) => item.verdict === "accept").map(toOut),
        rejected: outcome.rejected.map(toOut),
        committed_gap_ids,
        committed_need_ids,
      },
      summary: `${outcome.accepted.length} of ${outcome.proposed.length} gap candidate(s) accepted${
        input.dry_run ? " (dry run)" : `, ${committed_gap_ids.length} new gap(s) committed`
      }`,
      evals: outcome.metrics,
    };
  },
  evals: {
    async cases() {
      const curated = await curatedS2Cases();
      if (curated.length > 0) return curated;
      const documents = await listParsedDocuments();
      return documents.slice(0, 3).map((document) => ({
        name: document.source_id,
        input: { document_ids: [document.id], dry_run: true },
      }));
    },
    score({ case: testCase, output }) {
      const accepted = output.accepted.length;
      const total = accepted + output.rejected.length;
      const statements = output.accepted.map((row) => row.statement);
      const curated = scoreMustMatch(statements, testCase.gold?.must_match);
      if (accepted === 0) {
        return [
          { name: "curated_must_match", value: curated.value, unit: "ratio", target: testCase.gold?.must_match ? 0.5 : undefined, detail: curated.detail },
          { name: "gold_accept_rate", value: 0, unit: "ratio", detail: "no new candidates" },
          { name: "accepted_with_quote", value: 0, unit: "ratio", detail: "no new candidates" },
        ];
      }
      return [
        { name: "curated_must_match", value: curated.value, unit: "ratio", target: testCase.gold?.must_match ? 0.5 : undefined, detail: curated.detail },
        { name: "gold_accept_rate", value: total === 0 ? 0 : Number((accepted / total).toFixed(3)), unit: "ratio", target: 0.3 },
        { name: "accepted_with_quote", value: accepted === 0 ? 0 : Number((output.accepted.filter((c) => c.source_quote.trim().length > 0).length / accepted).toFixed(3)), unit: "ratio", target: 1 },
      ];
    },
  },
};

registerModule(gapExtractModule);

export async function listGapCandidates(limit = 200) {
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  return db().select().from(gapCandidates).orderBy(desc(gapCandidates.created_at)).limit(limit);
}

export async function gapCandidatesForRun(run_id: string) {
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  return db().select().from(gapCandidates).where(eq(gapCandidates.run_id, run_id));
}
